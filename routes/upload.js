const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { extractArchive, countPDFPages, generateCoverFromImage, generateCoverFromPDF } = require('../utils/extract');
const { autoFetchAndApplyCover } = require('../utils/covers');

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

        let bookId = null;
        try {
            const ext = path.extname(req.file.originalname).toLowerCase().replace('.', '');
            const title = req.body.title || path.basename(req.file.originalname, path.extname(req.file.originalname));
            const filePath = req.file.path;
            const filename = req.file.filename;
            const fileSize = req.file.size;
            const folderId = req.body.folder_id ? parseInt(req.body.folder_id, 10) : null;

            // Insert book record first to get ID
            const result = db.prepare(
                'INSERT INTO books (title, type, filename, file_size, folder_id) VALUES (?, ?, ?, ?, ?)'
            ).run(title, ext, filename, fileSize, folderId);

            bookId = result.lastInsertRowid;
            let totalPages = 0;
            let coverPath = null;

            if (ext === 'cbz' || ext === 'cbr') {
                const destDir = path.join(EXTRACTED_DIR, String(bookId));
                const pages = await extractArchive(filePath, destDir);
                totalPages = pages.length;

                // Generate cover from first page if file contains pages
                if (pages.length > 0) {
                    coverPath = `data/covers/${bookId}.jpg`;
                    await generateCoverFromImage(
                        path.join(destDir, pages[0]),
                        path.join(__dirname, '..', coverPath)
                    );
                } else {
                    // File does not contain pages: automatically fetch from Comic Vine
                    coverPath = await autoFetchAndApplyCover(bookId, title, db, COVERS_DIR);
                }
            } else if (ext === 'pdf') {
                totalPages = await countPDFPages(filePath);
                coverPath = `data/covers/${bookId}.jpg`;
                const realCoverExtracted = await generateCoverFromPDF(filePath, path.join(__dirname, '..', coverPath));
                if (!realCoverExtracted) {
                    // Placeholder generated: try fetching real cover from Comic Vine / online
                    const onlineCover = await autoFetchAndApplyCover(bookId, title, db, COVERS_DIR);
                    if (onlineCover) coverPath = onlineCover;
                }
            }

            // Fallback: if still no cover, attempt auto-fetch from Comic Vine
            if (!coverPath) {
                coverPath = await autoFetchAndApplyCover(bookId, title, db, COVERS_DIR);
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
            if (bookId) {
                try {
                    db.prepare('DELETE FROM books WHERE id = ?').run(bookId);
                    db.prepare('DELETE FROM reading_progress WHERE book_id = ?').run(bookId);
                } catch (e) {}
            }
            res.status(500).json({ error: err.message });
        }
    });

    return router;
};
