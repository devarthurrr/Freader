const express = require('express');
const router = express.Router();

module.exports = function (db) {

    // GET /api/books — list all books with progress
    router.get('/', (req, res) => {
        try {
            const books = db.prepare(`
        SELECT b.*, rp.current_page, rp.updated_at as progress_updated
        FROM books b
        LEFT JOIN reading_progress rp ON b.id = rp.book_id
        ORDER BY b.created_at DESC
      `).all();

            res.json(books);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // GET /api/books/:id — single book with progress
    router.get('/:id', (req, res) => {
        try {
            const book = db.prepare(`
        SELECT b.*, rp.current_page, rp.updated_at as progress_updated
        FROM books b
        LEFT JOIN reading_progress rp ON b.id = rp.book_id
        WHERE b.id = ?
      `).get(req.params.id);

            if (!book) return res.status(404).json({ error: 'Book not found' });
            res.json(book);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // DELETE /api/books/:id — remove book and its files
    router.delete('/:id', (req, res) => {
        const path = require('path');
        const fs = require('fs');

        try {
            const book = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
            if (!book) return res.status(404).json({ error: 'Book not found' });

            // Delete files
            const originalPath = path.join(__dirname, '..', 'data', 'originals', book.filename);
            if (fs.existsSync(originalPath)) fs.unlinkSync(originalPath);

            const extractedDir = path.join(__dirname, '..', 'data', 'extracted', String(book.id));
            if (fs.existsSync(extractedDir)) fs.rmSync(extractedDir, { recursive: true });

            if (book.cover_path) {
                const coverPath = path.join(__dirname, '..', book.cover_path);
                if (fs.existsSync(coverPath)) fs.unlinkSync(coverPath);
            }

            // Delete from DB
            db.prepare('DELETE FROM reading_progress WHERE book_id = ?').run(req.params.id);
            db.prepare('DELETE FROM books WHERE id = ?').run(req.params.id);

            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    return router;
};
