const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { extractCBZ, extractCBR, countPDFPages, generateCoverFromImage, generateCoverFromPDF } = require('../utils/extract');

const ORIGINALS_DIR = path.join(__dirname, '..', 'data', 'originals');
const EXTRACTED_DIR = path.join(__dirname, '..', 'data', 'extracted');
const COVERS_DIR = path.join(__dirname, '..', 'data', 'covers');

// Configure multer
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        fs.mkdirSync(ORIGINALS_DIR, { recursive: true });
        cb(null, ORIGINALS_DIR);
    },
    filename: (req, file, cb) => {
        // Keep original name but make it unique
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E4);
        const ext = path.extname(file.originalname).toLowerCase();
        const baseName = path.basename(file.originalname, path.extname(file.originalname));
        cb(null, `${baseName}-${uniqueSuffix}${ext}`);
    }
});

const fileFilter = (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.cbr', '.cbz', '.pdf'].includes(ext)) {
        cb(null, true);
    } else {
        cb(new Error('Only CBR, CBZ, and PDF files are allowed'), false);
    }
};

const upload = multer({
    storage,
    fileFilter,
    limits: { fileSize: 500 * 1024 * 1024 } // 500MB max
});

module.exports = function (db) {

    router.post('/', upload.single('file'), async (req, res) => {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        try {
            const ext = path.extname(req.file.originalname).toLowerCase().replace('.', '');
            const title = req.body.title || path.basename(req.file.originalname, path.extname(req.file.originalname));
            const filePath = req.file.path;
            const filename = req.file.filename;
            const fileSize = req.file.size;

            // Insert book record first to get ID
            const result = db.prepare(
                'INSERT INTO books (title, type, filename, file_size) VALUES (?, ?, ?, ?)'
            ).run(title, ext, filename, fileSize);

            const bookId = result.lastInsertRowid;
            let totalPages = 0;
            let coverPath = null;

            if (ext === 'cbz') {
                const destDir = path.join(EXTRACTED_DIR, String(bookId));
                const pages = await extractCBZ(filePath, destDir);
                totalPages = pages.length;

                // Generate cover from first page
                if (pages.length > 0) {
                    coverPath = `data/covers/${bookId}.jpg`;
                    await generateCoverFromImage(
                        path.join(destDir, pages[0]),
                        path.join(__dirname, '..', coverPath)
                    );
                }
            } else if (ext === 'cbr') {
                const destDir = path.join(EXTRACTED_DIR, String(bookId));
                const pages = await extractCBR(filePath, destDir);
                totalPages = pages.length;

                if (pages.length > 0) {
                    coverPath = `data/covers/${bookId}.jpg`;
                    await generateCoverFromImage(
                        path.join(destDir, pages[0]),
                        path.join(__dirname, '..', coverPath)
                    );
                }
            } else if (ext === 'pdf') {
                totalPages = await countPDFPages(filePath);
                coverPath = `data/covers/${bookId}.jpg`;
                await generateCoverFromPDF(filePath, path.join(__dirname, '..', coverPath));
            }

            // Update book with page count and cover
            db.prepare(
                'UPDATE books SET total_pages = ?, cover_path = ? WHERE id = ?'
            ).run(totalPages, coverPath, bookId);

            // Initialize reading progress
            db.prepare(
                'INSERT INTO reading_progress (book_id, current_page) VALUES (?, 1)'
            ).run(bookId);

            const book = db.prepare(`
        SELECT b.*, rp.current_page
        FROM books b
        LEFT JOIN reading_progress rp ON b.id = rp.book_id
        WHERE b.id = ?
      `).get(bookId);

            res.json({ success: true, book });
        } catch (err) {
            console.error('Upload error:', err);
            res.status(500).json({ error: err.message });
        }
    });

    return router;
};
