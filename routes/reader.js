const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');

module.exports = function (db) {

    // GET /api/books/:id/page/:num — serve a comic page image
    router.get('/:id/page/:num', (req, res) => {
        try {
            const book = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
            if (!book) return res.status(404).json({ error: 'Book not found' });

            if (book.type === 'pdf') {
                return res.status(400).json({ error: 'Use /file endpoint for PDFs' });
            }

            const pageNum = parseInt(req.params.num);
            const extractedDir = path.join(__dirname, '..', 'data', 'extracted', String(book.id));

            if (!fs.existsSync(extractedDir)) {
                return res.status(404).json({ error: 'Pages not extracted' });
            }

            // Find the page file
            const files = fs.readdirSync(extractedDir).sort();
            const pageIndex = pageNum - 1;

            if (pageIndex < 0 || pageIndex >= files.length) {
                return res.status(404).json({ error: 'Page not found' });
            }

            const pagePath = path.join(extractedDir, files[pageIndex]);
            res.sendFile(pagePath);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // GET /api/books/:id/file — serve raw file (for PDF)
    router.get('/:id/file', (req, res) => {
        try {
            const book = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
            if (!book) return res.status(404).json({ error: 'Book not found' });

            const filePath = path.join(__dirname, '..', 'data', 'originals', book.filename);
            if (!fs.existsSync(filePath)) {
                return res.status(404).json({ error: 'File not found' });
            }

            res.sendFile(filePath);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // GET /api/books/:id/cover — serve cover image
    router.get('/:id/cover', (req, res) => {
        try {
            const book = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
            if (!book) return res.status(404).json({ error: 'Book not found' });

            if (book.cover_path) {
                const coverPath = path.join(__dirname, '..', book.cover_path);
                if (fs.existsSync(coverPath)) {
                    return res.sendFile(coverPath);
                }
            }

            // Fallback placeholder
            res.status(404).json({ error: 'No cover available' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // POST /api/books/:id/progress — save reading progress
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

    // GET /api/books/:id/progress — get reading progress
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
