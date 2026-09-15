const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { extractArchive, isImageFile, naturalSort, generateCoverFromImage } = require('../utils/extract');

const ORIGINALS_DIR = path.join(__dirname, '..', 'data', 'originals');
const EXTRACTED_DIR = path.join(__dirname, '..', 'data', 'extracted');
const COVERS_DIR = path.join(__dirname, '..', 'data', 'covers');

module.exports = function (db) {

    // Helper: ensure comic pages are extracted on-demand
    async function ensureExtracted(book) {
        const extractedDir = path.join(EXTRACTED_DIR, String(book.id));
        let imageFiles = [];

        if (fs.existsSync(extractedDir)) {
            imageFiles = fs.readdirSync(extractedDir).filter(isImageFile).sort(naturalSort);
        }

        // If pages missing, try extracting from original archive
        if (imageFiles.length === 0) {
            const originalPath = path.join(ORIGINALS_DIR, book.filename);
            if (fs.existsSync(originalPath)) {
                try {
                    const pages = await extractArchive(originalPath, extractedDir);
                    if (pages.length > 0) {
                        imageFiles = pages;
                        // Update total_pages in database
                        db.prepare('UPDATE books SET total_pages = ? WHERE id = ?').run(pages.length, book.id);

                        // If cover is missing or broken, generate it from page 1
                        const coverRel = `data/covers/${book.id}.jpg`;
                        const coverAbs = path.join(__dirname, '..', coverRel);
                        if (!book.cover_path || !fs.existsSync(coverAbs)) {
                            try {
                                await generateCoverFromImage(path.join(extractedDir, pages[0]), coverAbs);
                                db.prepare('UPDATE books SET cover_path = ? WHERE id = ?').run(coverRel, book.id);
                            } catch (e) {
                                console.warn('Could not generate cover on auto-extract:', e.message);
                            }
                        }
                    }
                } catch (extractErr) {
                    console.error(`Auto-extract failed for book ${book.id}:`, extractErr.message);
                }
            }
        }

        return { extractedDir, imageFiles };
    }

    // GET /api/reader/:id/page/:num — serve a comic page image (with on-demand extraction)
    router.get('/:id/page/:num', async (req, res) => {
        try {
            const book = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
            if (!book) return res.status(404).json({ error: 'Book not found' });

            if (book.type === 'pdf') {
                return res.status(400).json({ error: 'Use /file endpoint for PDFs' });
            }

            const { extractedDir, imageFiles } = await ensureExtracted(book);

            if (imageFiles.length === 0) {
                return res.status(404).json({
                    error: 'Pages not extracted and original archive could not be unpacked'
                });
            }

            const pageNum = parseInt(req.params.num, 10);
            const pageIndex = pageNum - 1;

            if (pageIndex < 0 || pageIndex >= imageFiles.length) {
                return res.status(404).json({
                    error: `Page ${pageNum} not found (1 - ${imageFiles.length})`
                });
            }

            const pagePath = path.join(extractedDir, imageFiles[pageIndex]);
            res.sendFile(pagePath);
        } catch (err) {
            console.error('Reader page error:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // POST /api/reader/:id/extract — force re-extract comic pages and repair book
    router.post('/:id/extract', async (req, res) => {
        try {
            const bookId = parseInt(req.params.id, 10);
            const book = db.prepare('SELECT * FROM books WHERE id = ?').get(bookId);
            if (!book) return res.status(404).json({ error: 'Book not found' });
            if (book.type === 'pdf') return res.status(400).json({ error: 'Cannot extract PDF as comic' });

            const originalPath = path.join(ORIGINALS_DIR, book.filename);
            if (!fs.existsSync(originalPath)) {
                return res.status(404).json({ error: 'Original archive file not found' });
            }

            const extractedDir = path.join(EXTRACTED_DIR, String(bookId));
            if (fs.existsSync(extractedDir)) {
                fs.rmSync(extractedDir, { recursive: true, force: true });
            }

            const pages = await extractArchive(originalPath, extractedDir);
            const coverRel = `data/covers/${bookId}.jpg`;
            const coverAbs = path.join(__dirname, '..', coverRel);

            if (pages.length > 0) {
                await generateCoverFromImage(path.join(extractedDir, pages[0]), coverAbs);
                db.prepare('UPDATE books SET total_pages = ?, cover_path = ? WHERE id = ?')
                    .run(pages.length, coverRel, bookId);
            } else {
                db.prepare('UPDATE books SET total_pages = ? WHERE id = ?').run(0, bookId);
            }

            res.json({ success: true, book_id: bookId, total_pages: pages.length });
        } catch (err) {
            console.error('Re-extract error:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // GET /api/reader/:id/file — serve raw file (for PDF)
    router.get('/:id/file', (req, res) => {
        try {
            const book = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
            if (!book) return res.status(404).json({ error: 'Book not found' });

            const filePath = path.join(ORIGINALS_DIR, book.filename);
            if (!fs.existsSync(filePath)) {
                return res.status(404).json({ error: 'File not found' });
            }

            res.sendFile(filePath);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // GET /api/reader/:id/cover — serve cover image (auto-generate if missing)
    router.get('/:id/cover', async (req, res) => {
        try {
            const book = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
            if (!book) return res.status(404).json({ error: 'Book not found' });

            if (book.cover_path) {
                const coverPath = path.join(__dirname, '..', book.cover_path);
                if (fs.existsSync(coverPath)) {
                    return res.sendFile(coverPath);
                }
            }

            // Cover missing: attempt to auto-generate for comic
            if (book.type !== 'pdf') {
                const { extractedDir, imageFiles } = await ensureExtracted(book);
                if (imageFiles.length > 0) {
                    const coverRel = `data/covers/${book.id}.jpg`;
                    const coverAbs = path.join(__dirname, '..', coverRel);
                    await generateCoverFromImage(path.join(extractedDir, imageFiles[0]), coverAbs);
                    db.prepare('UPDATE books SET cover_path = ? WHERE id = ?').run(coverRel, book.id);
                    return res.sendFile(coverAbs);
                }
            }

            // If file contains no cover or generation failed: automatically fetch first result from Comic Vine
            try {
                const { autoFetchAndApplyCover } = require('../utils/covers');
                const autoCoverRel = await autoFetchAndApplyCover(book.id, book.title, db, COVERS_DIR);
                if (autoCoverRel) {
                    const autoCoverAbs = path.join(COVERS_DIR, `${book.id}.jpg`);
                    if (fs.existsSync(autoCoverAbs)) {
                        return res.sendFile(autoCoverAbs);
                    }
                }
            } catch (cvErr) {
                console.warn('Auto-fetch cover error in /cover route:', cvErr.message);
            }

            // Fallback placeholder
            res.status(404).json({ error: 'No cover available' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // POST /api/reader/:id/progress — save reading progress
    router.post('/:id/progress', (req, res) => {
        try {
            const { page } = req.body;
            const bookId = req.params.id;

            if (!page || page < 1) {
                return res.status(400).json({ error: 'Invalid page number' });
            }

            const book = db.prepare('SELECT * FROM books WHERE id = ?').get(bookId);
            if (!book) return res.status(404).json({ error: 'Book not found' });

            db.prepare(`
        INSERT INTO reading_progress (book_id, current_page, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(book_id) DO UPDATE SET
          current_page = excluded.current_page,
          updated_at = CURRENT_TIMESTAMP
      `).run(bookId, page);

            res.json({ success: true, page });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // GET /api/reader/:id/progress — get reading progress
    router.get('/:id/progress', (req, res) => {
        try {
            const progress = db.prepare(
                'SELECT * FROM reading_progress WHERE book_id = ?'
            ).get(req.params.id);

            res.json(progress || { book_id: parseInt(req.params.id), current_page: 1 });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    return router;
};
