const express = require('express');
const router = express.Router();

module.exports = function (db) {

    // GET /api/books — list books (filtered by folder_id, or search)
    router.get('/', (req, res) => {
        try {
            const { folder_id, search } = req.query;
            let query = `
                SELECT b.*, rp.current_page, rp.updated_at as progress_updated, f.name as folder_name
                FROM books b
                LEFT JOIN reading_progress rp ON b.id = rp.book_id
                LEFT JOIN folders f ON b.folder_id = f.id
            `;
            const conditions = [];
            const params = [];

            if (search && search.trim()) {
                conditions.push('b.title LIKE ?');
                params.push(`%${search.trim()}%`);
            }

            if (folder_id === 'all') {
                // Return all books across all folders
            } else if (folder_id !== undefined && folder_id !== 'null' && folder_id !== 'root' && folder_id !== '') {
                conditions.push('b.folder_id = ?');
                params.push(parseInt(folder_id, 10));
            } else if (folder_id === 'root' || folder_id === 'null' || (!search && folder_id === undefined)) {
                // Root level items (not inside any folder)
                conditions.push('b.folder_id IS NULL');
            }

            if (conditions.length > 0) {
                query += ' WHERE ' + conditions.join(' AND ');
            }

            query += ' ORDER BY b.created_at DESC';

            const books = db.prepare(query).all(...params);
            res.json(books);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // GET /api/books/:id — single book with progress and folder info
    router.get('/:id', async (req, res) => {
        try {
            const book = db.prepare(`
                SELECT b.*, rp.current_page, rp.updated_at as progress_updated, f.name as folder_name
                FROM books b
                LEFT JOIN reading_progress rp ON b.id = rp.book_id
                LEFT JOIN folders f ON b.folder_id = f.id
                WHERE b.id = ?
            `).get(req.params.id);

            if (!book) return res.status(404).json({ error: 'Book not found' });

            // If comic total_pages is 0 or missing, check extracted dir or auto-extract
            if (book.type !== 'pdf' && (!book.total_pages || book.total_pages === 0)) {
                const path = require('path');
                const fs = require('fs');
                const { isImageFile, extractArchive, generateCoverFromImage } = require('../utils/extract');
                const extractedDir = path.join(__dirname, '..', 'data', 'extracted', String(book.id));

                let count = 0;
                if (fs.existsSync(extractedDir)) {
                    count = fs.readdirSync(extractedDir).filter(isImageFile).length;
                }

                if (count === 0) {
                    const originalPath = path.join(__dirname, '..', 'data', 'originals', book.filename);
                    if (fs.existsSync(originalPath)) {
                        try {
                            const pages = await extractArchive(originalPath, extractedDir);
                            count = pages.length;
                            if (count > 0 && (!book.cover_path || !fs.existsSync(path.join(__dirname, '..', book.cover_path)))) {
                                const coverRel = `data/covers/${book.id}.jpg`;
                                await generateCoverFromImage(path.join(extractedDir, pages[0]), path.join(__dirname, '..', coverRel));
                                db.prepare('UPDATE books SET cover_path = ? WHERE id = ?').run(coverRel, book.id);
                                book.cover_path = coverRel;
                            }
                        } catch (e) {
                            console.warn('Auto-extract on book fetch failed:', e.message);
                        }
                    }
                }

                if (count > 0) {
                    db.prepare('UPDATE books SET total_pages = ? WHERE id = ?').run(count, book.id);
                    book.total_pages = count;
                }
            }

            res.json(book);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // PUT /api/books/:id/move — move single book to a folder (or root)
    router.put('/:id/move', (req, res) => {
        try {
            const bookId = parseInt(req.params.id, 10);
            const book = db.prepare('SELECT * FROM books WHERE id = ?').get(bookId);
            if (!book) return res.status(404).json({ error: 'Book not found' });

            let targetFolderId = req.body.folder_id !== undefined ? req.body.folder_id : null;
            if (targetFolderId !== null) {
                targetFolderId = parseInt(targetFolderId, 10);
                const folder = db.prepare('SELECT id FROM folders WHERE id = ?').get(targetFolderId);
                if (!folder) return res.status(404).json({ error: 'Target folder not found' });
            }

            db.prepare('UPDATE books SET folder_id = ? WHERE id = ?').run(targetFolderId, bookId);

            const updated = db.prepare(`
                SELECT b.*, rp.current_page, rp.updated_at as progress_updated, f.name as folder_name
                FROM books b
                LEFT JOIN reading_progress rp ON b.id = rp.book_id
                LEFT JOIN folders f ON b.folder_id = f.id
                WHERE b.id = ?
            `).get(bookId);

            res.json(updated);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // POST /api/books/move — batch move books to a folder (or root)
    router.post('/move', (req, res) => {
        try {
            const { book_ids, folder_id } = req.body;
            if (!Array.isArray(book_ids) || book_ids.length === 0) {
                return res.status(400).json({ error: 'book_ids array is required' });
            }

            let targetFolderId = folder_id !== undefined ? folder_id : null;
            if (targetFolderId !== null) {
                targetFolderId = parseInt(targetFolderId, 10);
                const folder = db.prepare('SELECT id FROM folders WHERE id = ?').get(targetFolderId);
                if (!folder) return res.status(404).json({ error: 'Target folder not found' });
            }

            const updateStmt = db.prepare('UPDATE books SET folder_id = ? WHERE id = ?');
            const runBatch = db.transaction((ids, fId) => {
                for (const id of ids) {
                    updateStmt.run(fId, id);
                }
            });

            runBatch(book_ids, targetFolderId);

            res.json({ success: true, count: book_ids.length, folder_id: targetFolderId });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // PUT /api/books/:id — update book details (title, folder_id)
    router.put('/:id', (req, res) => {
        try {
            const bookId = parseInt(req.params.id, 10);
            const book = db.prepare('SELECT * FROM books WHERE id = ?').get(bookId);
            if (!book) return res.status(404).json({ error: 'Book not found' });

            const { title, folder_id } = req.body;
            let newTitle = book.title;
            let newFolderId = book.folder_id;

            if (title && typeof title === 'string' && title.trim()) {
                newTitle = title.trim();
            }

            if (folder_id !== undefined) {
                newFolderId = folder_id !== null ? parseInt(folder_id, 10) : null;
                if (newFolderId !== null) {
                    const f = db.prepare('SELECT id FROM folders WHERE id = ?').get(newFolderId);
                    if (!f) return res.status(404).json({ error: 'Folder not found' });
                }
            }

            db.prepare('UPDATE books SET title = ?, folder_id = ? WHERE id = ?')
                .run(newTitle, newFolderId, bookId);

            const updated = db.prepare(`
                SELECT b.*, rp.current_page, rp.updated_at as progress_updated, f.name as folder_name
                FROM books b
                LEFT JOIN reading_progress rp ON b.id = rp.book_id
                LEFT JOIN folders f ON b.folder_id = f.id
                WHERE b.id = ?
            `).get(bookId);

            res.json(updated);
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
