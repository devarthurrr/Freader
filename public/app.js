/* ========================================
   FREADER — Application Logic with Folders
   ======================================== */

const API = '';

// ── Application State ──
let currentView = 'library';
let currentFolderId = null;        // null = Library Root, number = folder ID
let currentFolder = null;          // Folder object if inside a folder
let folderBreadcrumbs = [];        // Ancestors chain [{ id, name }]
let allFoldersTree = [];           // Cache of folders for picker dialogs
let currentBooks = [];
let currentFolders = [];
let searchQuery = '';
let searchDebounceTimer = null;

// Reader State
let currentBook = null;
let currentPage = 1;
let totalPages = 1;
let pdfDoc = null;
let controlsVisible = true;

// Drag & Drop State
let draggedItem = null; // { type: 'book' | 'folder', id: number, title: string }

// Modal State
let activeModal = null;
let editingFolderId = null; // null = create new, number = rename existing
let moveTarget = null;      // { type: 'book' | 'folder', id: number, title: string, currentParentId: number|null }
let selectedMoveFolderId = null;

// Upload Target State
let uploadTargetFolderId = null;
let uploadTargetFolderName = 'Library (Root)';

// ── Initialization ──
document.addEventListener('DOMContentLoaded', () => {
    setupNavigation();
    setupLibraryHeader();
    setupUpload();
    setupReader();
    setupModals();
    setupSettings();
    setupCoverModal();
    handleRoute();
    window.addEventListener('hashchange', handleRoute);
});

// ── Routing ──
function handleRoute() {
    const hash = window.location.hash || '#library';
    const parts = hash.slice(1).split('/');

    if (parts[0] === 'read' && parts[1]) {
        openBook(parseInt(parts[1], 10));
    } else if (parts[0] === 'upload') {
        switchTab('upload');
    } else if (parts[0] === 'folder' && parts[1]) {
        currentFolderId = parseInt(parts[1], 10);
        switchTab('library');
    } else if (parts[0] === 'library') {
        if (parts[1] === 'folder' && parts[2]) {
            currentFolderId = parseInt(parts[2], 10);
        } else {
            currentFolderId = null;
        }
        switchTab('library');
    } else {
        currentFolderId = null;
        switchTab('library');
    }
}

function navigateToFolder(folderId) {
    searchQuery = '';
    const searchInput = document.getElementById('library-search');
    if (searchInput) searchInput.value = '';
    const searchClear = document.getElementById('search-clear');
    if (searchClear) searchClear.style.display = 'none';

    if (folderId === null || folderId === undefined) {
        window.location.hash = '#library';
    } else {
        window.location.hash = `#library/folder/${folderId}`;
    }
}

// ── Navigation ──
function setupNavigation() {
    document.querySelectorAll('.nav-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const tabName = tab.dataset.tab;
            if (tabName === 'library') {
                if (currentView === 'library' && currentFolderId !== null) {
                    // Clicking Library tab while in subfolder goes to root
                    navigateToFolder(null);
                    return;
                }
                window.location.hash = '#library';
            } else {
                window.location.hash = `#${tabName}`;
            }
        });
    });
}

function switchTab(tabName) {
    if (tabName === 'library') {
        loadLibrary();
    } else if (tabName === 'upload') {
        // Sync upload target folder with current folder if navigated from library
        if (currentFolderId !== null && currentFolder) {
            uploadTargetFolderId = currentFolderId;
            uploadTargetFolderName = currentFolder.name;
        } else if (uploadTargetFolderId === null) {
            uploadTargetFolderName = 'Library (Root)';
        }
        updateUploadTargetUI();
    }

    if (currentView === 'reader' && tabName !== 'reader') {
        closePDF();
    }

    currentView = tabName;

    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
    const activeTab = document.querySelector(`[data-tab="${tabName}"]`);
    if (activeTab) activeTab.classList.add('active');

    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    const activeView = document.getElementById(`view-${tabName}`);
    if (activeView) activeView.classList.add('active');

    // Show/hide navbar in reader
    const navbar = document.getElementById('navbar');
    if (navbar) navbar.style.display = tabName === 'reader' ? 'none' : 'flex';
}

// ── Library Header, Search & Breadcrumbs ──
function setupLibraryHeader() {
    const btnNewFolder = document.getElementById('btn-new-folder');
    if (btnNewFolder) {
        btnNewFolder.addEventListener('click', () => openCreateFolderModal());
    }

    const emptyBtnFolder = document.getElementById('empty-btn-folder');
    if (emptyBtnFolder) {
        emptyBtnFolder.addEventListener('click', () => openCreateFolderModal());
    }

    const searchInput = document.getElementById('library-search');
    const searchClear = document.getElementById('search-clear');

    if (searchInput) {
        searchInput.addEventListener('input', e => {
            clearTimeout(searchDebounceTimer);
            searchQuery = e.target.value.trim();

            if (searchClear) {
                searchClear.style.display = searchQuery ? 'block' : 'none';
            }

            searchDebounceTimer = setTimeout(() => {
                loadLibrary();
            }, 250);
        });
    }

    if (searchClear) {
        searchClear.addEventListener('click', () => {
            if (searchInput) searchInput.value = '';
            searchQuery = '';
            searchClear.style.display = 'none';
            loadLibrary();
        });
    }

    // Close any context menu when clicking elsewhere
    document.addEventListener('click', e => {
        if (!e.target.closest('.context-menu') && !e.target.closest('.folder-menu-btn') && !e.target.closest('.card-action-btn')) {
            closeContextMenu();
        }
    });
}

// ── Library Loading & Rendering ──
async function loadLibrary() {
    try {
        let foldersUrl = `${API}/api/folders`;
        let booksUrl = `${API}/api/books`;

        if (searchQuery) {
            // In search mode, search across all books and folders
            foldersUrl = `${API}/api/folders?parent_id=all`;
            booksUrl = `${API}/api/books?folder_id=all&search=${encodeURIComponent(searchQuery)}`;
        } else if (currentFolderId !== null) {
            foldersUrl = `${API}/api/folders?parent_id=${currentFolderId}`;
            booksUrl = `${API}/api/books?folder_id=${currentFolderId}`;
        } else {
            // Root level
            foldersUrl = `${API}/api/folders`; // parent_id IS NULL
            booksUrl = `${API}/api/books?folder_id=root`;
        }

        // Fetch folder details for breadcrumbs if in a folder and not searching
        if (currentFolderId !== null && !searchQuery) {
            try {
                const folderRes = await fetch(`${API}/api/folders/${currentFolderId}`);
                if (folderRes.ok) {
                    currentFolder = await folderRes.json();
                    folderBreadcrumbs = currentFolder.breadcrumbs || [];
                } else {
                    // Folder no longer exists, return to root
                    navigateToFolder(null);
                    return;
                }
            } catch (e) {
                console.error('Failed to load folder details:', e);
            }
        } else {
            currentFolder = null;
            folderBreadcrumbs = [];
        }

        const [foldersRes, booksRes] = await Promise.all([
            fetch(foldersUrl),
            fetch(booksUrl)
        ]);

        let folders = await foldersRes.json();
        let books = await booksRes.json();

        // Filter folders by search query if in search mode
        if (searchQuery) {
            const q = searchQuery.toLowerCase();
            folders = folders.filter(f => f.name.toLowerCase().includes(q));
        }

        currentFolders = folders;
        currentBooks = books;

        renderBreadcrumbs();
        renderFolders(folders);
        renderBooks(books);
        updateLibraryStats(folders.length, books.length);
    } catch (err) {
        console.error('Failed to load library:', err);
        showToast('Failed to load library', true);
    }
}

function updateLibraryStats(folderCount, bookCount) {
    const statsEl = document.getElementById('library-stats');
    const titleEl = document.getElementById('library-title');

    if (searchQuery) {
        if (titleEl) titleEl.textContent = `Search: "${searchQuery}"`;
    } else if (currentFolder) {
        if (titleEl) titleEl.textContent = currentFolder.name;
    } else {
        if (titleEl) titleEl.textContent = 'Your Library';
    }

    if (!statsEl) return;

    if (folderCount === 0 && bookCount === 0) {
        statsEl.textContent = '';
        return;
    }

    const parts = [];
    if (folderCount > 0) parts.push(`${folderCount} folder${folderCount !== 1 ? 's' : ''}`);
    if (bookCount > 0) parts.push(`${bookCount} book${bookCount !== 1 ? 's' : ''}`);
    statsEl.textContent = parts.join(' · ');
}

// ── Breadcrumbs ──
function renderBreadcrumbs() {
    const container = document.getElementById('library-breadcrumbs');
    if (!container) return;

    if (searchQuery) {
        container.innerHTML = `
            <div class="breadcrumb-item" onclick="navigateToFolder(null)">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
                    <polyline points="9 22 9 12 15 12 15 22"></polyline>
                </svg>
                <span>Library</span>
            </div>
            <span class="breadcrumb-separator">/</span>
            <div class="breadcrumb-item active">
                <span>Search results</span>
            </div>
        `;
        return;
    }

    const crumbs = [{ id: null, name: 'Library' }];
    if (folderBreadcrumbs && folderBreadcrumbs.length > 0) {
        crumbs.push(...folderBreadcrumbs);
    }

    container.innerHTML = crumbs.map((crumb, idx) => {
        const isLast = idx === crumbs.length - 1;
        const targetId = crumb.id;
        const isRoot = crumb.id === null;

        const crumbHtml = `
            <div class="breadcrumb-item ${isLast ? 'active' : ''}"
                 data-folder-id="${targetId === null ? 'root' : targetId}"
                 ${!isLast ? `onclick="navigateToFolder(${targetId})"` : ''}
                 ondragover="handleBreadcrumbDragOver(event)"
                 ondragleave="handleBreadcrumbDragLeave(event)"
                 ondrop="handleBreadcrumbDrop(event, ${targetId})">
                ${isRoot ? `
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
                        <polyline points="9 22 9 12 15 12 15 22"></polyline>
                    </svg>
                ` : `
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                    </svg>
                `}
                <span>${escapeHtml(crumb.name)}</span>
            </div>
        `;

        if (isLast) return crumbHtml;
        return crumbHtml + `<span class="breadcrumb-separator">/</span>`;
    }).join('');
}

// ── Render Folders ──
function renderFolders(folders) {
    const section = document.getElementById('folders-section');
    const grid = document.getElementById('folders-grid');

    if (!section || !grid) return;

    if (folders.length === 0) {
        section.style.display = 'none';
        grid.innerHTML = '';
        return;
    }

    section.style.display = 'block';
    grid.innerHTML = folders.map(folder => {
        const previewHtml = (folder.preview_covers && folder.preview_covers.length > 0)
            ? `<div class="folder-preview-stack">
                 ${folder.preview_covers.slice(0, 3).map(c => `<img class="folder-preview-thumb" src="${c}" alt="">`).join('')}
               </div>`
            : '';

        const metaParts = [];
        if (folder.book_count !== undefined) metaParts.push(`${folder.book_count} book${folder.book_count !== 1 ? 's' : ''}`);
        if (folder.subfolder_count !== undefined && folder.subfolder_count > 0) {
            metaParts.push(`${folder.subfolder_count} folder${folder.subfolder_count !== 1 ? 's' : ''}`);
        }
        const metaText = metaParts.length > 0 ? metaParts.join(' · ') : 'Empty';

        return `
            <div class="folder-card"
                 id="folder-card-${folder.id}"
                 data-folder-id="${folder.id}"
                 draggable="true"
                 ondragstart="handleFolderDragStart(event, ${folder.id}, '${escapeJs(folder.name)}')"
                 ondragover="handleFolderDragOver(event)"
                 ondragleave="handleFolderDragLeave(event)"
                 ondrop="handleFolderDrop(event, ${folder.id})"
                 onclick="navigateToFolder(${folder.id})">
                <div class="folder-icon-wrapper">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                    </svg>
                    ${previewHtml}
                </div>
                <div class="folder-info">
                    <div class="folder-name" title="${escapeHtml(folder.name)}">${escapeHtml(folder.name)}</div>
                    <div class="folder-meta">${metaText}</div>
                </div>
                <button class="folder-menu-btn" onclick="event.stopPropagation(); showFolderMenu(event, ${folder.id}, '${escapeJs(folder.name)}', ${folder.parent_id || 'null'})" title="Folder Options">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="1.5"></circle>
                        <circle cx="12" cy="5" r="1.5"></circle>
                        <circle cx="12" cy="19" r="1.5"></circle>
                    </svg>
                </button>
            </div>
        `;
    }).join('');
}

// ── Render Books ──
function renderBooks(books) {
    const section = document.getElementById('books-section');
    const heading = document.getElementById('books-heading');
    const grid = document.getElementById('books-grid');
    const empty = document.getElementById('empty-library');
    const emptyMsg = document.getElementById('empty-message');

    if (!grid || !empty) return;

    // Show books heading if both folders and books exist
    if (heading) {
        heading.style.display = (currentFolders.length > 0 && books.length > 0) ? 'block' : 'none';
    }

    if (books.length === 0 && currentFolders.length === 0) {
        if (section) section.style.display = 'none';
        empty.style.display = 'flex';
        if (emptyMsg) {
            if (searchQuery) {
                emptyMsg.textContent = `No items found matching "${searchQuery}"`;
            } else if (currentFolder) {
                emptyMsg.textContent = `"${currentFolder.name}" is empty`;
            } else {
                emptyMsg.textContent = 'Your library is empty';
            }
        }
        return;
    }

    if (section) section.style.display = 'block';
    empty.style.display = 'none';

    if (books.length === 0) {
        grid.innerHTML = '';
        return;
    }

    grid.innerHTML = books.map(book => {
        const progress = book.current_page && book.total_pages
            ? Math.round((book.current_page / book.total_pages) * 100)
            : 0;
        const coverUrl = `${API}/api/reader/${book.id}/cover`;

        return `
            <div class="book-card"
                 id="book-card-${book.id}"
                 data-book-id="${book.id}"
                 draggable="true"
                 ondragstart="handleBookDragStart(event, ${book.id}, '${escapeJs(book.title)}')"
                 onclick="openBook(${book.id})"
                 title="${escapeHtml(book.title)}">
                <div class="card-actions">
                    <button class="card-action-btn btn-cover"
                            onclick="event.stopPropagation(); openCoverModal(${book.id}, '${escapeJs(book.title)}')"
                            title="Change cover">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                            <circle cx="8.5" cy="8.5" r="1.5"></circle>
                            <polyline points="21 15 16 10 5 21"></polyline>
                        </svg>
                    </button>
                    <button class="card-action-btn btn-move"
                            onclick="event.stopPropagation(); openMoveModal('book', ${book.id}, '${escapeJs(book.title)}', ${book.folder_id || 'null'})"
                            title="Move to folder">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                            <polyline points="12 11 12 17 15 14"></polyline>
                        </svg>
                    </button>
                    <button class="card-action-btn btn-delete"
                            onclick="event.stopPropagation(); deleteBook(${book.id}, '${escapeJs(book.title)}')"
                            title="Delete book">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <line x1="18" y1="6" x2="6" y2="18"></line>
                            <line x1="6" y1="6" x2="18" y2="18"></line>
                        </svg>
                    </button>
                </div>
                <img class="book-cover" src="${coverUrl}" alt="${escapeHtml(book.title)}"
                     onerror="this.style.background='var(--bg-surface)'">
                <div class="book-info">
                    <div class="book-title">${escapeHtml(book.title)}</div>
                    <div class="book-meta">
                        <span class="book-type-badge">${book.type.toUpperCase()}</span>
                        <span>${book.total_pages} pg</span>
                    </div>
                    <div class="book-progress-bar">
                        <div class="book-progress-fill" style="width: ${progress}%"></div>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

// ── Context Menu ──
let activeContextMenu = null;

function closeContextMenu() {
    if (activeContextMenu) {
        activeContextMenu.remove();
        activeContextMenu = null;
    }
}

function showFolderMenu(e, folderId, folderName, parentId) {
    closeContextMenu();

    const menu = document.createElement('div');
    menu.className = 'context-menu';

    menu.innerHTML = `
        <button class="context-menu-item" onclick="openRenameFolderModal(${folderId}, '${escapeJs(folderName)}')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
            </svg>
            <span>Rename</span>
        </button>
        <button class="context-menu-item" onclick="openMoveModal('folder', ${folderId}, '${escapeJs(folderName)}', ${parentId !== null ? parentId : 'null'})">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                <polyline points="12 11 12 17 15 14"></polyline>
            </svg>
            <span>Move</span>
        </button>
        <button class="context-menu-item danger" onclick="deleteFolder(${folderId}, '${escapeJs(folderName)}')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"></polyline>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
            <span>Delete</span>
        </button>
    `;

    document.body.appendChild(menu);

    const rect = e.target.getBoundingClientRect();
    menu.style.top = `${Math.min(window.innerHeight - 150, rect.bottom + 4)}px`;
    menu.style.left = `${Math.max(10, rect.right - 140)}px`;

    activeContextMenu = menu;
}

// ── Drag & Drop Handlers ──
function handleBookDragStart(e, bookId, title) {
    draggedItem = { type: 'book', id: bookId, title };
    e.dataTransfer.setData('text/plain', JSON.stringify(draggedItem));
    e.dataTransfer.effectAllowed = 'move';
    const card = document.getElementById(`book-card-${bookId}`);
    if (card) card.classList.add('dragging');

    // Clean up drag class after drop/cancel
    setTimeout(() => {
        if (card) card.classList.remove('dragging');
    }, 500);
}

function handleFolderDragStart(e, folderId, name) {
    draggedItem = { type: 'folder', id: folderId, title: name };
    e.dataTransfer.setData('text/plain', JSON.stringify(draggedItem));
    e.dataTransfer.effectAllowed = 'move';
    const card = document.getElementById(`folder-card-${folderId}`);
    if (card) card.classList.add('dragging');

    setTimeout(() => {
        if (card) card.classList.remove('dragging');
    }, 500);
}

function handleFolderDragOver(e) {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    const card = e.currentTarget;
    if (!card.classList.contains('drag-over')) {
        card.classList.add('drag-over');
    }
}

function handleFolderDragLeave(e) {
    e.stopPropagation();
    e.currentTarget.classList.remove('drag-over');
}

async function handleFolderDrop(e, targetFolderId) {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.classList.remove('drag-over');

    if (!draggedItem) return;

    if (draggedItem.type === 'book') {
        await moveBook(draggedItem.id, targetFolderId);
    } else if (draggedItem.type === 'folder') {
        if (draggedItem.id === targetFolderId) {
            showToast('Cannot move a folder into itself', true);
            return;
        }
        await moveFolder(draggedItem.id, targetFolderId);
    }
    draggedItem = null;
}

function handleBreadcrumbDragOver(e) {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    e.currentTarget.classList.add('drag-over');
}

function handleBreadcrumbDragLeave(e) {
    e.stopPropagation();
    e.currentTarget.classList.remove('drag-over');
}

async function handleBreadcrumbDrop(e, targetFolderId) {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.classList.remove('drag-over');

    if (!draggedItem) return;

    if (draggedItem.type === 'book') {
        await moveBook(draggedItem.id, targetFolderId);
    } else if (draggedItem.type === 'folder') {
        if (draggedItem.id === targetFolderId) return;
        await moveFolder(draggedItem.id, targetFolderId);
    }
    draggedItem = null;
}

// ── Book & Folder Actions ──
async function moveBook(bookId, targetFolderId) {
    try {
        const res = await fetch(`${API}/api/books/${bookId}/move`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folder_id: targetFolderId })
        });

        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || 'Failed to move book');
        }

        const data = await res.json();
        showToast(targetFolderId ? `Moved to "${data.folder_name || 'folder'}"` : 'Moved to Library Root');
        loadLibrary();
    } catch (err) {
        showToast(err.message, true);
    }
}

async function moveFolder(folderId, targetParentId) {
    try {
        const res = await fetch(`${API}/api/folders/${folderId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ parent_id: targetParentId })
        });

        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || 'Failed to move folder');
        }

        showToast(targetParentId ? 'Folder moved successfully' : 'Folder moved to Library Root');
        loadLibrary();
    } catch (err) {
        showToast(err.message, true);
    }
}

async function deleteBook(id, title) {
    if (!confirm(`Delete "${title}"?`)) return;

    try {
        const res = await fetch(`${API}/api/books/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('Failed to delete');
        showToast('Book deleted');
        loadLibrary();
    } catch (err) {
        showToast('Failed to delete book', true);
    }
}

async function deleteFolder(id, name) {
    closeContextMenu();
    if (!confirm(`Delete folder "${name}"?\n\nBooks and subfolders inside will be moved up safely.`)) return;

    try {
        const res = await fetch(`${API}/api/folders/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('Failed to delete folder');
        showToast(`Folder "${name}" deleted`);
        loadLibrary();
    } catch (err) {
        showToast('Failed to delete folder', true);
    }
}

// ── Modals Setup & Handlers ──
function setupModals() {
    // Close modal on Escape key or backdrop click
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', e => {
            if (e.target === overlay) closeModal(overlay.id);
        });
    });

    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && activeModal) {
            closeModal(activeModal);
        }
    });

    // Move modal confirmation button
    const btnMoveConfirm = document.getElementById('btn-move-confirm');
    if (btnMoveConfirm) {
        btnMoveConfirm.addEventListener('click', () => confirmMove());
    }

    // Change upload target button
    const btnChangeUpload = document.getElementById('btn-change-upload-target');
    if (btnChangeUpload) {
        btnChangeUpload.addEventListener('click', () => openUploadTargetPicker());
    }
}

function openModal(modalId) {
    closeContextMenu();
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.style.display = 'flex';
        activeModal = modalId;
    }
}

function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.style.display = 'none';
        if (activeModal === modalId) activeModal = null;
    }
}

// Folder Create / Rename Modal
function openCreateFolderModal() {
    editingFolderId = null;
    document.getElementById('modal-folder-title').textContent = currentFolder
        ? `Create Subfolder in "${currentFolder.name}"`
        : 'Create New Folder';
    document.getElementById('btn-folder-submit').textContent = 'Create';
    const input = document.getElementById('folder-name-input');
    input.value = '';
    openModal('modal-folder');
    setTimeout(() => input.focus(), 50);
}

function openRenameFolderModal(folderId, currentName) {
    closeContextMenu();
    editingFolderId = folderId;
    document.getElementById('modal-folder-title').textContent = 'Rename Folder';
    document.getElementById('btn-folder-submit').textContent = 'Save';
    const input = document.getElementById('folder-name-input');
    input.value = currentName;
    openModal('modal-folder');
    setTimeout(() => {
        input.focus();
        input.select();
    }, 50);
}

async function handleFolderFormSubmit(e) {
    e.preventDefault();
    const input = document.getElementById('folder-name-input');
    const name = input.value.trim();
    if (!name) return;

    try {
        if (editingFolderId === null) {
            // Create folder
            const parentId = currentFolderId;
            const res = await fetch(`${API}/api/folders`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, parent_id: parentId })
            });

            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || 'Failed to create folder');
            }

            showToast(`Folder "${name}" created`);
        } else {
            // Rename folder
            const res = await fetch(`${API}/api/folders/${editingFolderId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name })
            });

            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || 'Failed to rename folder');
            }

            showToast(`Folder renamed to "${name}"`);
        }

        closeModal('modal-folder');
        loadLibrary();
    } catch (err) {
        showToast(err.message, true);
    }
}

// Move Item Modal (Folder Picker)
let moveActionCallback = null;

async function openMoveModal(type, id, title, currentParentId) {
    closeContextMenu();
    moveTarget = { type, id, title, currentParentId };
    selectedMoveFolderId = currentParentId;
    moveActionCallback = null;

    document.getElementById('modal-move-title').textContent = type === 'book' ? `Move "${title}"` : `Move Folder "${title}"`;
    document.getElementById('modal-move-instruction').textContent = 'Select destination folder:';
    document.getElementById('btn-move-confirm').textContent = 'Move Here';

    await renderFolderPickerTree(id, type === 'folder');
    openModal('modal-move');
}

async function openUploadTargetPicker() {
    moveTarget = null;
    selectedMoveFolderId = uploadTargetFolderId;

    document.getElementById('modal-move-title').textContent = 'Select Upload Target';
    document.getElementById('modal-move-instruction').textContent = 'Choose which folder uploaded books will be saved into:';
    document.getElementById('btn-move-confirm').textContent = 'Select Folder';

    moveActionCallback = (folderId, folderName) => {
        uploadTargetFolderId = folderId;
        uploadTargetFolderName = folderName;
        updateUploadTargetUI();
        closeModal('modal-move');
        showToast(`Upload target set to: ${folderName}`);
    };

    await renderFolderPickerTree(null, false);
    openModal('modal-move');
}

async function renderFolderPickerTree(excludedFolderId = null, isMovingFolder = false) {
    const container = document.getElementById('move-folder-tree');
    if (!container) return;

    container.innerHTML = '<div style="padding:12px;color:var(--text-muted);font-size:13px;">Loading folders…</div>';

    try {
        const res = await fetch(`${API}/api/folders/tree`);
        const allFolders = await res.json();
        allFoldersTree = allFolders;

        // Build parent-children map
        const childrenMap = {};
        allFolders.forEach(f => {
            const pId = f.parent_id === null ? 'root' : String(f.parent_id);
            if (!childrenMap[pId]) childrenMap[pId] = [];
            childrenMap[pId].push(f);
        });

        // If moving a folder, find all descendants to disable them
        const disabledIds = new Set();
        if (isMovingFolder && excludedFolderId !== null) {
            disabledIds.add(excludedFolderId);
            const addDescendants = (parentId) => {
                const children = childrenMap[String(parentId)] || [];
                for (const ch of children) {
                    disabledIds.add(ch.id);
                    addDescendants(ch.id);
                }
            };
            addDescendants(excludedFolderId);
        }

        let html = '';

        // Root item
        const isRootSelected = selectedMoveFolderId === null;
        html += `
            <div class="folder-picker-item ${isRootSelected ? 'selected' : ''}"
                 onclick="selectFolderPickerItem(null, 'Library (Root)')">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
                    <polyline points="9 22 9 12 15 12 15 22"></polyline>
                </svg>
                <span><strong>Library (Root)</strong></span>
            </div>
        `;

        // Recursive tree builder
        const buildTreeHtml = (parentId, depth) => {
            const children = childrenMap[parentId === null ? 'root' : String(parentId)] || [];
            for (const folder of children) {
                const isSelected = selectedMoveFolderId === folder.id;
                const isDisabled = disabledIds.has(folder.id);
                const indent = depth * 18;

                html += `
                    <div class="folder-picker-item ${isSelected ? 'selected' : ''} ${isDisabled ? 'disabled' : ''}"
                         style="padding-left: ${indent + 12}px;"
                         ${!isDisabled ? `onclick="selectFolderPickerItem(${folder.id}, '${escapeJs(folder.name)}')"` : ''}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                        </svg>
                        <span>${escapeHtml(folder.name)}</span>
                        ${isDisabled ? '<span style="font-size:11px;color:var(--text-muted);margin-left:auto;">(current/child)</span>' : ''}
                    </div>
                `;

                buildTreeHtml(folder.id, depth + 1);
            }
        };

        buildTreeHtml(null, 0);
        container.innerHTML = html;
    } catch (err) {
        console.error('Failed to render folder picker:', err);
        container.innerHTML = '<div style="padding:12px;color:var(--danger);font-size:13px;">Failed to load folders</div>';
    }
}

function selectFolderPickerItem(folderId, folderName) {
    selectedMoveFolderId = folderId;

    if (moveActionCallback) {
        moveActionCallback(folderId, folderName);
        return;
    }

    // Update active highlight in picker
    document.querySelectorAll('.folder-picker-item').forEach(el => el.classList.remove('selected'));
    const target = event.currentTarget;
    if (target) target.classList.add('selected');
}

async function confirmMove() {
    if (!moveTarget) return;

    const { type, id } = moveTarget;
    closeModal('modal-move');

    if (type === 'book') {
        await moveBook(id, selectedMoveFolderId);
    } else if (type === 'folder') {
        await moveFolder(id, selectedMoveFolderId);
    }
}

// ── Upload ──
function updateUploadTargetUI() {
    const targetEl = document.getElementById('upload-target-name');
    if (targetEl) {
        targetEl.textContent = uploadTargetFolderName;
    }
}

function setupUpload() {
    const zone = document.getElementById('upload-zone');
    const input = document.getElementById('file-input');

    if (!zone || !input) return;

    zone.addEventListener('click', () => input.click());

    zone.addEventListener('dragover', e => {
        e.preventDefault();
        zone.classList.add('drag-over');
    });

    zone.addEventListener('dragleave', () => {
        zone.classList.remove('drag-over');
    });

    zone.addEventListener('drop', e => {
        e.preventDefault();
        zone.classList.remove('drag-over');
        handleFiles(e.dataTransfer.files);
    });

    input.addEventListener('change', () => {
        handleFiles(input.files);
        input.value = '';
    });
}

function handleFiles(fileList) {
    const files = Array.from(fileList).filter(f => {
        const ext = f.name.split('.').pop().toLowerCase();
        return ['cbr', 'cbz', 'pdf'].includes(ext);
    });

    if (files.length === 0) {
        showToast('No valid files selected (CBR, CBZ, or PDF)', true);
        return;
    }

    files.forEach(uploadFile);
}

async function uploadFile(file) {
    const queue = document.getElementById('upload-queue');
    const itemId = `upload-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;

    const itemEl = document.createElement('div');
    itemEl.className = 'upload-item';
    itemEl.id = itemId;
    itemEl.innerHTML = `
        <div class="upload-item-info">
            <div class="upload-item-name">${escapeHtml(file.name)}</div>
            <div class="upload-item-size">${formatFileSize(file.size)} · target: ${escapeHtml(uploadTargetFolderName)}</div>
            <div class="upload-progress">
                <div class="upload-progress-fill" id="${itemId}-progress"></div>
            </div>
        </div>
        <span class="upload-status uploading" id="${itemId}-status">Uploading…</span>
    `;
    queue.prepend(itemEl);

    const formData = new FormData();
    formData.append('file', file);
    if (uploadTargetFolderId !== null) {
        formData.append('folder_id', uploadTargetFolderId);
    }

    try {
        const xhr = new XMLHttpRequest();

        xhr.upload.addEventListener('progress', e => {
            if (e.lengthComputable) {
                const pct = Math.round((e.loaded / e.total) * 100);
                const progressEl = document.getElementById(`${itemId}-progress`);
                if (progressEl) progressEl.style.width = `${pct}%`;
            }
        });

        await new Promise((resolve, reject) => {
            xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    const statusEl = document.getElementById(`${itemId}-status`);
                    if (statusEl) {
                        statusEl.className = 'upload-status done';
                        statusEl.textContent = 'Done ✓';
                    }
                    resolve();
                } else {
                    reject(new Error(xhr.responseText));
                }
            };

            xhr.onerror = () => reject(new Error('Network error'));

            xhr.onreadystatechange = () => {
                if (xhr.readyState === 4 && xhr.status >= 200 && xhr.status < 300) {
                    const statusEl = document.getElementById(`${itemId}-status`);
                    if (statusEl) {
                        statusEl.className = 'upload-status processing';
                        statusEl.textContent = 'Processing…';
                    }
                }
            };

            xhr.open('POST', `${API}/api/upload`);
            xhr.send(formData);
        });

        showToast(`"${file.name}" uploaded to ${uploadTargetFolderName}`);
    } catch (err) {
        const statusEl = document.getElementById(`${itemId}-status`);
        if (statusEl) {
            statusEl.className = 'upload-status error';
            statusEl.textContent = 'Error';
        }
        showToast(`Failed to upload "${file.name}"`, true);
    }
}

// ── Reader ──
function setupReader() {
    const readerBack = document.getElementById('reader-back');
    if (readerBack) {
        readerBack.addEventListener('click', () => {
            if (currentFolderId !== null) {
                window.location.hash = `#library/folder/${currentFolderId}`;
            } else {
                window.location.hash = '#library';
            }
        });
    }

    const comicPrev = document.getElementById('comic-prev');
    const comicNext = document.getElementById('comic-next');
    const btnPrev = document.getElementById('btn-prev-page');
    const btnNext = document.getElementById('btn-next-page');

    if (comicPrev) comicPrev.addEventListener('click', () => goToPage(currentPage - 1));
    if (comicNext) comicNext.addEventListener('click', () => goToPage(currentPage + 1));
    if (btnPrev) btnPrev.addEventListener('click', () => goToPage(currentPage - 1));
    if (btnNext) btnNext.addEventListener('click', () => goToPage(currentPage + 1));

    const slider = document.getElementById('page-slider');
    if (slider) {
        slider.addEventListener('input', () => {
            goToPage(parseInt(slider.value, 10));
        });
    }

    // Keyboard navigation
    document.addEventListener('keydown', e => {
        if (currentView !== 'reader') return;

        switch (e.key) {
            case 'ArrowLeft':
            case 'ArrowUp':
                e.preventDefault();
                goToPage(currentPage - 1);
                break;
            case 'ArrowRight':
            case 'ArrowDown':
                e.preventDefault();
                goToPage(currentPage + 1);
                break;
            case 'Escape':
                if (currentFolderId !== null) {
                    window.location.hash = `#library/folder/${currentFolderId}`;
                } else {
                    window.location.hash = '#library';
                }
                break;
        }
    });

    // Toggle controls on click
    const viewReader = document.getElementById('view-reader');
    if (viewReader) {
        viewReader.addEventListener('click', e => {
            if (e.target.closest('.reader-controls') || e.target.closest('.reader-bottom') ||
                e.target.closest('.comic-nav-zone') || e.target.closest('.page-nav-btn')) return;
            toggleControls();
        });

        // Touch swipe support
        let touchStartX = 0;
        viewReader.addEventListener('touchstart', e => {
            touchStartX = e.changedTouches[0].screenX;
        }, { passive: true });

        viewReader.addEventListener('touchend', e => {
            const diff = e.changedTouches[0].screenX - touchStartX;
            if (Math.abs(diff) > 50) {
                if (diff > 0) goToPage(currentPage - 1);
                else goToPage(currentPage + 1);
            }
        }, { passive: true });
    }
}

async function openBook(bookId) {
    try {
        const res = await fetch(`${API}/api/books/${bookId}`);
        currentBook = await res.json();

        // Remember which folder this book is in so back returns to that folder
        if (currentBook.folder_id) {
            currentFolderId = currentBook.folder_id;
        }

        totalPages = currentBook.total_pages;
        currentPage = currentBook.current_page || 1;

        const titleEl = document.getElementById('reader-title');
        const sliderEl = document.getElementById('page-slider');

        if (titleEl) titleEl.textContent = currentBook.title;
        if (sliderEl) sliderEl.max = totalPages;

        switchTab('reader');

        if (currentBook.type === 'pdf') {
            document.getElementById('comic-reader').style.display = 'none';
            document.getElementById('pdf-reader').style.display = 'flex';
            await initPDFReader(currentBook.id);
        } else {
            document.getElementById('pdf-reader').style.display = 'none';
            document.getElementById('comic-reader').style.display = 'flex';
            goToPage(currentPage);
        }
    } catch (err) {
        showToast('Failed to open book', true);
    }
}

function goToPage(page) {
    if (!currentBook) return;
    if (page < 1 || page > totalPages) return;

    currentPage = page;

    // Update UI
    const pageInfo = document.getElementById('reader-page-info');
    const slider = document.getElementById('page-slider');
    if (pageInfo) pageInfo.textContent = `${currentPage} / ${totalPages}`;
    if (slider) slider.value = currentPage;

    // Load content
    if (currentBook.type === 'pdf') {
        renderPDFPage(currentPage);
    } else {
        const img = document.getElementById('comic-page');
        if (img) img.src = `${API}/api/reader/${currentBook.id}/page/${currentPage}`;
    }

    // Save progress
    saveProgress();
}

let saveTimeout = null;
function saveProgress() {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(async () => {
        if (!currentBook) return;
        try {
            await fetch(`${API}/api/reader/${currentBook.id}/progress`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ page: currentPage })
            });
        } catch (err) {
            // Silent fail for progress save
        }
    }, 500);
}

// ── PDF Rendering ──
async function initPDFReader(bookId) {
    try {
        const pdfjsLib = await import('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs');
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs';

        const loadingTask = pdfjsLib.getDocument(`${API}/api/reader/${bookId}/file`);
        pdfDoc = await loadingTask.promise;
        totalPages = pdfDoc.numPages;
        const slider = document.getElementById('page-slider');
        if (slider) slider.max = totalPages;
        goToPage(currentPage);
    } catch (err) {
        showToast('Failed to load PDF', true);
        console.error(err);
    }
}

async function renderPDFPage(pageNum) {
    if (!pdfDoc) return;

    try {
        const page = await pdfDoc.getPage(pageNum);
        const canvas = document.getElementById('pdf-canvas');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');

        const container = document.getElementById('pdf-reader');
        const containerWidth = container.clientWidth;
        const containerHeight = container.clientHeight;

        const viewport = page.getViewport({ scale: 1 });
        const scaleX = containerWidth / viewport.width;
        const scaleY = containerHeight / viewport.height;
        const scale = Math.min(scaleX, scaleY) * (window.devicePixelRatio || 1);

        const scaledViewport = page.getViewport({ scale });
        canvas.width = scaledViewport.width;
        canvas.height = scaledViewport.height;
        canvas.style.width = `${scaledViewport.width / (window.devicePixelRatio || 1)}px`;
        canvas.style.height = `${scaledViewport.height / (window.devicePixelRatio || 1)}px`;

        await page.render({ canvasContext: ctx, viewport: scaledViewport }).promise;
    } catch (err) {
        console.error('PDF render error:', err);
    }
}

function closePDF() {
    if (pdfDoc) {
        pdfDoc.destroy();
        pdfDoc = null;
    }
    currentBook = null;
}

// ── Controls Visibility ──
function toggleControls() {
    controlsVisible = !controlsVisible;
    const controls = document.getElementById('reader-controls');
    const bottom = document.getElementById('reader-bottom');
    if (controls) controls.classList.toggle('hidden', !controlsVisible);
    if (bottom) bottom.classList.toggle('hidden', !controlsVisible);
}

// ── Toast ──
function showToast(message, isError = false) {
    let container = document.querySelector('.toast-container');
    if (!container) {
        container = document.createElement('div');
        container.className = 'toast-container';
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `toast${isError ? ' error' : ''}`;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(12px)';
        toast.style.transition = 'all 0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// ── Cover Management ──
let currentCoverBookId = null;
let currentCoverPageNum = 1;
let currentCoverTotalPages = 1;
let currentCoverBook = null;

function setupCoverModal() {
    // Tabs switching
    document.querySelectorAll('.modal-tab[data-cover-tab]').forEach(tab => {
        tab.addEventListener('click', () => {
            switchCoverTab(tab.dataset.coverTab);
        });
    });

    // Online Search handlers
    const btnSearch = document.getElementById('btn-run-cover-search');
    const inputSearch = document.getElementById('cover-search-input');
    const sourceSelect = document.getElementById('cover-search-source');

    if (btnSearch) {
        btnSearch.addEventListener('click', () => searchOnlineCovers());
    }

    if (inputSearch) {
        inputSearch.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
                e.preventDefault();
                searchOnlineCovers();
            }
        });
    }

    if (sourceSelect) {
        sourceSelect.addEventListener('change', () => {
            searchOnlineCovers();
        });
    }

    // File Page picker handlers
    const btnPrevPage = document.getElementById('btn-cover-prev-page');
    const btnNextPage = document.getElementById('btn-cover-next-page');
    const numInput = document.getElementById('cover-page-number-input');
    const slider = document.getElementById('cover-page-slider');
    const btnApplyPage = document.getElementById('btn-apply-file-page-cover');

    if (btnPrevPage) {
        btnPrevPage.addEventListener('click', () => setCoverPage(currentCoverPageNum - 1));
    }
    if (btnNextPage) {
        btnNextPage.addEventListener('click', () => setCoverPage(currentCoverPageNum + 1));
    }
    if (slider) {
        slider.addEventListener('input', () => setCoverPage(parseInt(slider.value, 10)));
    }
    if (numInput) {
        numInput.addEventListener('change', () => setCoverPage(parseInt(numInput.value, 10)));
    }
    if (btnApplyPage) {
        btnApplyPage.addEventListener('click', () => applyCoverFromPage());
    }

    // Custom URL & Upload handlers
    const btnApplyUrl = document.getElementById('btn-apply-custom-url');
    if (btnApplyUrl) {
        btnApplyUrl.addEventListener('click', () => applyCoverFromCustomUrl());
    }

    const dropzone = document.getElementById('cover-upload-dropzone');
    const fileInput = document.getElementById('cover-custom-file-input');

    if (dropzone && fileInput) {
        dropzone.addEventListener('click', () => fileInput.click());

        dropzone.addEventListener('dragover', e => {
            e.preventDefault();
            dropzone.classList.add('drag-over');
        });
        dropzone.addEventListener('dragleave', () => {
            dropzone.classList.remove('drag-over');
        });
        dropzone.addEventListener('drop', e => {
            e.preventDefault();
            dropzone.classList.remove('drag-over');
            if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                applyCoverFromFile(e.dataTransfer.files[0]);
            }
        });

        fileInput.addEventListener('change', () => {
            if (fileInput.files && fileInput.files.length > 0) {
                applyCoverFromFile(fileInput.files[0]);
                fileInput.value = '';
            }
        });
    }
}

async function openCoverModal(bookId, bookTitle) {
    currentCoverBookId = bookId;
    currentCoverPageNum = 1;

    const modalTitle = document.getElementById('modal-cover-book-title');
    if (modalTitle) modalTitle.textContent = bookTitle;

    const searchInput = document.getElementById('cover-search-input');
    if (searchInput) searchInput.value = bookTitle;

    // Clear previous search results
    const resultsContainer = document.getElementById('cover-search-results');
    if (resultsContainer) resultsContainer.innerHTML = '';
    const keyBanner = document.getElementById('comicvine-key-banner');
    if (keyBanner) keyBanner.style.display = 'none';

    switchCoverTab('online');
    openModal('modal-cover');

    // Fetch book details to populate pages tab and Comic Vine key check
    try {
        const [pagesRes, settingsRes] = await Promise.all([
            fetch(`${API}/api/covers/pages/${bookId}`),
            fetch(`${API}/api/covers/settings`)
        ]);

        if (pagesRes.ok) {
            const data = await pagesRes.json();
            currentCoverBook = data;
            currentCoverTotalPages = data.total_pages || 1;

            const slider = document.getElementById('cover-page-slider');
            const numInput = document.getElementById('cover-page-number-input');
            const totalLabel = document.getElementById('cover-page-total-label');

            if (slider) { slider.min = 1; slider.max = currentCoverTotalPages; slider.value = 1; }
            if (numInput) { numInput.min = 1; numInput.max = currentCoverTotalPages; numInput.value = 1; }
            if (totalLabel) totalLabel.textContent = `/ ${currentCoverTotalPages}`;

            updateCoverPagePreview(1);
        }

        if (settingsRes.ok) {
            const settings = await settingsRes.json();
            const sourceSelect = document.getElementById('cover-search-source');
            if (!settings.comicvine_configured) {
                if (sourceSelect && sourceSelect.value === 'comicvine') {
                    sourceSelect.value = 'googlebooks';
                }
            }
        }
    } catch (e) {
        console.error('Failed to prepare cover modal:', e);
    }

    // Automatically trigger search
    searchOnlineCovers();
}

function switchCoverTab(tabName) {
    document.querySelectorAll('.modal-tab[data-cover-tab]').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.coverTab === tabName);
    });

    document.querySelectorAll('.cover-tab-panel').forEach(panel => {
        panel.style.display = 'none';
        panel.classList.remove('active');
    });

    const activePanel = document.getElementById(`cover-tab-panel-${tabName}`);
    if (activePanel) {
        activePanel.style.display = 'flex';
        activePanel.classList.add('active');
    }
}

function switchCoverSearchSource(source) {
    const select = document.getElementById('cover-search-source');
    if (select) {
        select.value = source;
        searchOnlineCovers();
    }
}

async function searchOnlineCovers() {
    const searchInput = document.getElementById('cover-search-input');
    const sourceSelect = document.getElementById('cover-search-source');
    const loadingEl = document.getElementById('cover-search-loading');
    const resultsContainer = document.getElementById('cover-search-results');
    const keyBanner = document.getElementById('comicvine-key-banner');

    const query = searchInput ? searchInput.value.trim() : '';
    const source = sourceSelect ? sourceSelect.value : 'comicvine';

    if (!query) {
        showToast('Please enter a search term', true);
        return;
    }

    if (loadingEl) loadingEl.style.display = 'flex';
    if (resultsContainer) resultsContainer.innerHTML = '';
    if (keyBanner) keyBanner.style.display = 'none';

    try {
        const res = await fetch(`${API}/api/covers/search?query=${encodeURIComponent(query)}&source=${source}`);
        const data = await res.json();

        if (loadingEl) loadingEl.style.display = 'none';

        if (data.requires_key && keyBanner) {
            keyBanner.style.display = 'flex';
        }

        if (!data.results || data.results.length === 0) {
            resultsContainer.innerHTML = `
                <div style="grid-column: 1 / -1; text-align: center; padding: 32px 0; color: var(--text-muted); font-size: 13px;">
                    ${data.error ? `Search error: ${escapeHtml(data.error)}` : `No covers found for "${escapeHtml(query)}". Try selecting another source like Google Books or Open Library.`}
                </div>
            `;
            return;
        }

        resultsContainer.innerHTML = data.results.map(item => {
            const badgeLabel = item.source === 'comicvine' ? 'Comic Vine' : (item.source === 'googlebooks' ? 'Google Books' : 'Open Library');
            return `
                <div class="cover-result-card">
                    <div class="cover-result-thumb-wrapper">
                        <span class="cover-result-badge">${badgeLabel}</span>
                        <img class="cover-result-thumb" src="${item.cover_url}" alt="${escapeHtml(item.title)}" onerror="this.src='data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'100\' height=\'150\' fill=\'%23222\'><text x=\'50%\' y=\'50%\' fill=\'%23666\' text-anchor=\'middle\'>No image</text></svg>'">
                    </div>
                    <div class="cover-result-info">
                        <div class="cover-result-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
                        <div class="cover-result-sub">${escapeHtml(item.subtitle || '')}</div>
                        <button class="cover-result-btn" onclick="applyCoverFromUrl('${escapeJs(item.cover_url)}')">Apply Cover</button>
                    </div>
                </div>
            `;
        }).join('');
    } catch (err) {
        if (loadingEl) loadingEl.style.display = 'none';
        resultsContainer.innerHTML = `
            <div style="grid-column: 1 / -1; text-align: center; padding: 32px 0; color: var(--danger); font-size: 13px;">
                Search request failed: ${escapeHtml(err.message)}
            </div>
        `;
    }
}

async function applyCoverFromUrl(url) {
    if (!currentCoverBookId) return;

    showToast('Downloading and applying cover…');

    try {
        const res = await fetch(`${API}/api/covers/apply/${currentCoverBookId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'url', url })
        });

        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || 'Failed to apply cover');
        }

        const data = await res.json();
        showToast('Cover updated successfully!');
        refreshBookCoverInUI(currentCoverBookId, data.cover_url);
        closeModal('modal-cover');
    } catch (err) {
        showToast(err.message, true);
    }
}

function setCoverPage(pageNum) {
    if (pageNum < 1) pageNum = 1;
    if (pageNum > currentCoverTotalPages) pageNum = currentCoverTotalPages;

    currentCoverPageNum = pageNum;

    const slider = document.getElementById('cover-page-slider');
    const numInput = document.getElementById('cover-page-number-input');

    if (slider) slider.value = currentCoverPageNum;
    if (numInput) numInput.value = currentCoverPageNum;

    updateCoverPagePreview(currentCoverPageNum);
}

function updateCoverPagePreview(pageNum) {
    const previewImg = document.getElementById('cover-page-preview-img');
    if (!previewImg || !currentCoverBookId) return;

    if (currentCoverBook && currentCoverBook.type === 'pdf') {
        previewImg.src = `${API}/api/reader/${currentCoverBookId}/cover?t=${Date.now()}`;
    } else {
        previewImg.src = `${API}/api/reader/${currentCoverBookId}/page/${pageNum}`;
    }
}

async function applyCoverFromPage() {
    if (!currentCoverBookId) return;

    showToast(`Setting page ${currentCoverPageNum} as cover…`);

    try {
        const res = await fetch(`${API}/api/covers/apply/${currentCoverBookId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'page', page_num: currentCoverPageNum })
        });

        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || 'Failed to extract cover');
        }

        const data = await res.json();
        showToast('Cover updated from page successfully!');
        refreshBookCoverInUI(currentCoverBookId, data.cover_url);
        closeModal('modal-cover');
    } catch (err) {
        showToast(err.message, true);
    }
}

async function applyCoverFromCustomUrl() {
    const input = document.getElementById('cover-custom-url-input');
    const url = input ? input.value.trim() : '';

    if (!url) {
        showToast('Please enter an image URL', true);
        return;
    }

    await applyCoverFromUrl(url);
}

async function applyCoverFromFile(file) {
    if (!currentCoverBookId || !file) return;

    if (!file.type.startsWith('image/')) {
        showToast('Please select a valid image file (JPG, PNG, WebP)', true);
        return;
    }

    showToast('Uploading and applying cover…');

    const formData = new FormData();
    formData.append('image', file);
    formData.append('type', 'upload');

    try {
        const res = await fetch(`${API}/api/covers/apply/${currentCoverBookId}`, {
            method: 'POST',
            body: formData
        });

        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || 'Failed to upload cover');
        }

        const data = await res.json();
        showToast('Cover updated from uploaded image!');
        refreshBookCoverInUI(currentCoverBookId, data.cover_url);
        closeModal('modal-cover');
    } catch (err) {
        showToast(err.message, true);
    }
}

function refreshBookCoverInUI(bookId, newCoverUrl) {
    const timestamp = Date.now();
    const url = newCoverUrl || `${API}/api/reader/${bookId}/cover?t=${timestamp}`;

    const card = document.getElementById(`book-card-${bookId}`);
    if (card) {
        const coverImg = card.querySelector('.book-cover');
        if (coverImg) {
            coverImg.src = url;
        }
    }

    // Also update any preview thumbnails in folders
    document.querySelectorAll(`.folder-preview-thumb[src*="/api/reader/${bookId}/cover"]`).forEach(img => {
        img.src = url;
    });
}

// ── Settings Modal ──
function setupSettings() {
    const btnOpenSettings = document.getElementById('btn-open-settings');
    if (btnOpenSettings) {
        btnOpenSettings.addEventListener('click', () => openSettingsModal());
    }
}

async function openSettingsModal() {
    try {
        const res = await fetch(`${API}/api/covers/settings`);
        const settings = await res.json();

        const badge = document.getElementById('comicvine-status-badge');
        const input = document.getElementById('setting-comicvine-key');

        if (badge) {
            if (settings.comicvine_configured) {
                badge.className = 'status-badge active';
                badge.textContent = 'Configured ✓';
            } else {
                badge.className = 'status-badge';
                badge.textContent = 'Not configured';
            }
        }

        if (input) {
            input.value = settings.comicvine_masked_key || '';
        }

        openModal('modal-settings');
    } catch (err) {
        showToast('Failed to load settings', true);
    }
}

async function handleSettingsFormSubmit(e) {
    e.preventDefault();
    const input = document.getElementById('setting-comicvine-key');
    const key = input ? input.value.trim() : '';

    if (key.includes('••••')) {
        closeModal('modal-settings');
        return;
    }

    try {
        const res = await fetch(`${API}/api/covers/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ comicvine_api_key: key })
        });

        if (!res.ok) throw new Error('Failed to save settings');

        showToast('Settings saved successfully');
        closeModal('modal-settings');
    } catch (err) {
        showToast(err.message, true);
    }
}

// ── Helpers ──
function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function escapeJs(str) {
    if (!str) return '';
    return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"');
}

function formatFileSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
