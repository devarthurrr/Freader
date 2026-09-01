/* ========================================
   FREADER — Application Logic
   ======================================== */

const API = '';

// ── State ──
let currentView = 'library';
let currentBook = null;
let currentPage = 1;
let totalPages = 1;
let pdfDoc = null;
let controlsVisible = true;
let controlsTimer = null;

// ── Init ──
document.addEventListener('DOMContentLoaded', () => {
    setupNavigation();
    setupUpload();
    setupReader();
    loadLibrary();
    handleRoute();
    window.addEventListener('hashchange', handleRoute);
});

// ── Routing ──
function handleRoute() {
    const hash = window.location.hash || '#library';
    const parts = hash.slice(1).split('/');

    if (parts[0] === 'read' && parts[1]) {
        openBook(parseInt(parts[1]));
    } else if (parts[0] === 'upload') {
        switchTab('upload');
    } else {
        switchTab('library');
    }
}

// ── Navigation ──
function setupNavigation() {
    document.querySelectorAll('.nav-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            switchTab(tab.dataset.tab);
            window.location.hash = `#${tab.dataset.tab}`;
        });
    });
}

function switchTab(tabName) {
    if (tabName === 'library') loadLibrary();

    // Hide reader if switching away
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
    document.getElementById('navbar').style.display =
        tabName === 'reader' ? 'none' : 'flex';
}

// ── Library ──
async function loadLibrary() {
    try {
        const res = await fetch(`${API}/api/books`);
        const books = await res.json();
        renderLibrary(books);
    } catch (err) {
        showToast('Failed to load library', true);
    }
}

function renderLibrary(books) {
    const grid = document.getElementById('books-grid');
    const empty = document.getElementById('empty-library');
    const stats = document.getElementById('library-stats');

    if (books.length === 0) {
        grid.style.display = 'none';
        empty.style.display = 'flex';
        stats.textContent = '';
        return;
    }

    grid.style.display = 'grid';
    empty.style.display = 'none';
    stats.textContent = `${books.length} book${books.length !== 1 ? 's' : ''}`;

    grid.innerHTML = books.map(book => {
        const progress = book.current_page && book.total_pages
            ? Math.round((book.current_page / book.total_pages) * 100)
            : 0;
        const coverUrl = `${API}/api/reader/${book.id}/cover`;

        return `
      <div class="book-card" onclick="openBook(${book.id})" title="${escapeHtml(book.title)}">
        <button class="book-delete" onclick="event.stopPropagation(); deleteBook(${book.id}, '${escapeHtml(book.title)}')" title="Delete">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
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

async function deleteBook(id, title) {
    if (!confirm(`Delete "${title}"?`)) return;

    try {
        await fetch(`${API}/api/books/${id}`, { method: 'DELETE' });
        showToast('Book deleted');
        loadLibrary();
    } catch (err) {
        showToast('Failed to delete book', true);
    }
}

// ── Upload ──
function setupUpload() {
    const zone = document.getElementById('upload-zone');
    const input = document.getElementById('file-input');

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
      <div class="upload-item-size">${formatFileSize(file.size)}</div>
      <div class="upload-progress">
        <div class="upload-progress-fill" id="${itemId}-progress"></div>
      </div>
    </div>
    <span class="upload-status uploading" id="${itemId}-status">Uploading…</span>
  `;
    queue.prepend(itemEl);

    const formData = new FormData();
    formData.append('file', file);

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
                    const progressEl = document.getElementById(`${itemId}-progress`);
                    if (statusEl) {
                        statusEl.className = 'upload-status processing';
                        statusEl.textContent = 'Processing…';
                    }
                }
            };

            xhr.open('POST', `${API}/api/upload`);
            xhr.send(formData);
        });

        showToast(`"${file.name}" uploaded successfully`);
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
    document.getElementById('reader-back').addEventListener('click', () => {
        window.location.hash = '#library';
    });

    document.getElementById('comic-prev').addEventListener('click', () => goToPage(currentPage - 1));
    document.getElementById('comic-next').addEventListener('click', () => goToPage(currentPage + 1));
    document.getElementById('btn-prev-page').addEventListener('click', () => goToPage(currentPage - 1));
    document.getElementById('btn-next-page').addEventListener('click', () => goToPage(currentPage + 1));

    const slider = document.getElementById('page-slider');
    slider.addEventListener('input', () => {
        goToPage(parseInt(slider.value));
    });

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
                window.location.hash = '#library';
                break;
        }
    });

    // Toggle controls on click (center area)
    document.getElementById('view-reader').addEventListener('click', e => {
        if (e.target.closest('.reader-controls') || e.target.closest('.reader-bottom') ||
            e.target.closest('.comic-nav-zone') || e.target.closest('.page-nav-btn')) return;
        toggleControls();
    });

    // Touch swipe support
    let touchStartX = 0;
    const readerView = document.getElementById('view-reader');

    readerView.addEventListener('touchstart', e => {
        touchStartX = e.changedTouches[0].screenX;
    }, { passive: true });

    readerView.addEventListener('touchend', e => {
        const diff = e.changedTouches[0].screenX - touchStartX;
        if (Math.abs(diff) > 50) {
            if (diff > 0) goToPage(currentPage - 1);
            else goToPage(currentPage + 1);
        }
    }, { passive: true });
}

async function openBook(bookId) {
    try {
        const res = await fetch(`${API}/api/books/${bookId}`);
        currentBook = await res.json();

        totalPages = currentBook.total_pages;
        currentPage = currentBook.current_page || 1;

        document.getElementById('reader-title').textContent = currentBook.title;
        document.getElementById('page-slider').max = totalPages;

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
    document.getElementById('reader-page-info').textContent = `${currentPage} / ${totalPages}`;
    document.getElementById('page-slider').value = currentPage;

    // Load content
    if (currentBook.type === 'pdf') {
        renderPDFPage(currentPage);
    } else {
        const img = document.getElementById('comic-page');
        img.src = `${API}/api/reader/${currentBook.id}/page/${currentPage}`;
    }

    // Save progress (debounced)
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
        document.getElementById('page-slider').max = totalPages;
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
        const ctx = canvas.getContext('2d');

        // Scale to fit container
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

// ── Controls visibility ──
function toggleControls() {
    controlsVisible = !controlsVisible;
    const controls = document.getElementById('reader-controls');
    const bottom = document.getElementById('reader-bottom');
    controls.classList.toggle('hidden', !controlsVisible);
    bottom.classList.toggle('hidden', !controlsVisible);
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

// ── Helpers ──
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function formatFileSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
