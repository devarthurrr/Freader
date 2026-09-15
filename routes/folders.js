const express = require('express');
const router = express.Router();

module.exports = function (db) {

    // Helper: get ancestor breadcrumbs for a folder
    function getBreadcrumbs(folderId) {
        if (!folderId) return [];
        try {
            const crumbs = db.prepare(`
                WITH RECURSIVE ancestors AS (
                    SELECT id, name, parent_id, 0 as level FROM folders WHERE id = ?
                    UNION ALL
                    SELECT f.id, f.name, f.parent_id, a.level + 1
                    FROM folders f
                    JOIN ancestors a ON f.id = a.parent_id
                )
                SELECT id, name, parent_id FROM ancestors ORDER BY level DESC
            `).all(folderId);
            return crumbs;
        } catch (err) {
            console.error('Breadcrumb error:', err);
            return [];
        }
    }

    // GET /api/folders/tree — full folder tree / list for folder picker modals
    router.get('/tree', (req, res) => {
        try {
            const folders = db.prepare(`
                SELECT f.*,
                    (SELECT COUNT(*) FROM books b WHERE b.folder_id = f.id) as book_count,
                    (SELECT COUNT(*) FROM folders sub WHERE sub.parent_id = f.id) as subfolder_count
                FROM folders f
                ORDER BY f.name COLLATE NOCASE ASC
            `).all();

            res.json(folders);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // GET /api/folders — list folders by parent_id (or root if not provided)
    router.get('/', (req, res) => {
        try {
            const { parent_id } = req.query;

            let folders;
            if (parent_id === 'all') {
                folders = db.prepare(`
                    SELECT f.*,
                        (SELECT COUNT(*) FROM books b WHERE b.folder_id = f.id) as book_count,
                        (SELECT COUNT(*) FROM folders sub WHERE sub.parent_id = f.id) as subfolder_count
                    FROM folders f
                    ORDER BY f.name COLLATE NOCASE ASC
                `).all();
            } else if (parent_id !== undefined && parent_id !== 'null' && parent_id !== '') {
                folders = db.prepare(`
                    SELECT f.*,
                        (SELECT COUNT(*) FROM books b WHERE b.folder_id = f.id) as book_count,
                        (SELECT COUNT(*) FROM folders sub WHERE sub.parent_id = f.id) as subfolder_count
                    FROM folders f
                    WHERE f.parent_id = ?
                    ORDER BY f.name COLLATE NOCASE ASC
                `).all(parent_id);
            } else {
                folders = db.prepare(`
                    SELECT f.*,
                        (SELECT COUNT(*) FROM books b WHERE b.folder_id = f.id) as book_count,
                        (SELECT COUNT(*) FROM folders sub WHERE sub.parent_id = f.id) as subfolder_count
                    FROM folders f
                    WHERE f.parent_id IS NULL
                    ORDER BY f.name COLLATE NOCASE ASC
                `).all();
            }

            // Attach preview cover images for each folder
            const getPreviewCovers = db.prepare(`
                SELECT id, cover_path FROM books
                WHERE folder_id = ? AND cover_path IS NOT NULL
                ORDER BY created_at DESC
                LIMIT 3
            `);

            const result = folders.map(folder => {
                const covers = getPreviewCovers.all(folder.id);
                return {
                    ...folder,
                    preview_covers: covers.map(c => `/api/reader/${c.id}/cover`)
                };
            });

            res.json(result);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // GET /api/folders/:id — single folder with breadcrumbs
    router.get('/:id', (req, res) => {
        try {
            const folder = db.prepare(`
                SELECT f.*,
                    (SELECT COUNT(*) FROM books b WHERE b.folder_id = f.id) as book_count,
                    (SELECT COUNT(*) FROM folders sub WHERE sub.parent_id = f.id) as subfolder_count
                FROM folders f
                WHERE f.id = ?
            `).get(req.params.id);

            if (!folder) return res.status(404).json({ error: 'Folder not found' });

            folder.breadcrumbs = getBreadcrumbs(folder.id);

            res.json(folder);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // POST /api/folders — create new folder
    router.post('/', (req, res) => {
        try {
            let { name, parent_id } = req.body;
            if (!name || typeof name !== 'string' || !name.trim()) {
                return res.status(400).json({ error: 'Folder name is required' });
            }

            name = name.trim();
            const parentId = parent_id ? parseInt(parent_id, 10) : null;

            if (parentId) {
                const parent = db.prepare('SELECT id FROM folders WHERE id = ?').get(parentId);
                if (!parent) return res.status(404).json({ error: 'Parent folder does not exist' });
            }

            const info = db.prepare(
                'INSERT INTO folders (name, parent_id) VALUES (?, ?)'
            ).run(name, parentId);

            const created = db.prepare('SELECT * FROM folders WHERE id = ?').get(info.lastInsertRowid);
            created.book_count = 0;
            created.subfolder_count = 0;
            created.preview_covers = [];

            res.status(201).json(created);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // PUT /api/folders/:id — rename or move folder
    router.put('/:id', (req, res) => {
        try {
            const folderId = parseInt(req.params.id, 10);
            const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(folderId);
            if (!folder) return res.status(404).json({ error: 'Folder not found' });

            const { name, parent_id } = req.body;
            let newName = folder.name;
            let newParentId = folder.parent_id;

            if (name !== undefined) {
                if (typeof name !== 'string' || !name.trim()) {
                    return res.status(400).json({ error: 'Folder name cannot be empty' });
                }
                newName = name.trim();
            }

            if (parent_id !== undefined) {
                newParentId = parent_id ? parseInt(parent_id, 10) : null;

                if (newParentId === folderId) {
                    return res.status(400).json({ error: 'A folder cannot be its own parent' });
                }

                if (newParentId !== null) {
                    // Check parent exists
                    const targetParent = db.prepare('SELECT id FROM folders WHERE id = ?').get(newParentId);
                    if (!targetParent) return res.status(404).json({ error: 'Target parent folder not found' });

                    // Check circular dependency: ensure target is not a descendant
                    const isDescendant = db.prepare(`
                        WITH RECURSIVE descendants AS (
                            SELECT id FROM folders WHERE parent_id = ?
                            UNION ALL
                            SELECT f.id FROM folders f JOIN descendants d ON f.parent_id = d.id
                        )
                        SELECT 1 FROM descendants WHERE id = ?
                    `).get(folderId, newParentId);

                    if (isDescendant) {
                        return res.status(400).json({ error: 'Cannot move a folder into one of its subfolders' });
                    }
                }
            }

            db.prepare('UPDATE folders SET name = ?, parent_id = ? WHERE id = ?')
                .run(newName, newParentId, folderId);

            const updated = db.prepare(`
                SELECT f.*,
                    (SELECT COUNT(*) FROM books b WHERE b.folder_id = f.id) as book_count,
                    (SELECT COUNT(*) FROM folders sub WHERE sub.parent_id = f.id) as subfolder_count
                FROM folders f
                WHERE f.id = ?
            `).get(folderId);

            res.json(updated);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // DELETE /api/folders/:id — safely delete folder, preserving books & subfolders
    router.delete('/:id', (req, res) => {
        try {
            const folderId = parseInt(req.params.id, 10);
            const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(folderId);
            if (!folder) return res.status(404).json({ error: 'Folder not found' });

            const parentId = folder.parent_id; // null if was at root

            // Move books in this folder up to parent folder (or root)
            db.prepare('UPDATE books SET folder_id = ? WHERE folder_id = ?')
                .run(parentId, folderId);

            // Move subfolders in this folder up to parent folder (or root)
            db.prepare('UPDATE folders SET parent_id = ? WHERE parent_id = ?')
                .run(parentId, folderId);

            // Delete folder itself
            db.prepare('DELETE FROM folders WHERE id = ?').run(folderId);

            res.json({ success: true, moved_to_parent_id: parentId });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    return router;
};
