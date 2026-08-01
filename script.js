// Initialization logic executed early to set dark/light theme instantly
const savedTheme = localStorage.getItem('theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
document.documentElement.setAttribute('data-theme', savedTheme);

const API_WORKER_URL = 'https://amernewsapi.amerhabib.workers.dev/';
let globalData = [];
let filteredData = [];
const itemsPerPage = 20; // Articles rendered per UI chunk
let currentDisplayed = itemsPerPage;

const CACHE_KEY = 'amernews_data';
const CACHE_TIME_KEY = 'amernews_time';
const CACHE_TTL = 3 * 60 * 1000;

let isFetching = false;
let fetchPageNum = 1;          // Tracks server page offset for Baserow pagination
let hasMoreServerData = true;  // Explicit flag to control infinite scroll exhaustion

let activeCategories = safeParse(localStorage.getItem('newsCategories'), ['All']);
let activeSources = safeParse(localStorage.getItem('newsSources'), ['All']);
let activeLanguages = safeParse(localStorage.getItem('newsLanguages'), ['All']);
let currentView = localStorage.getItem('newsView') || (window.innerWidth < 768 ? 'grid-2' : 'grid-4');
let searchDebounce = null;

let carouselInterval, currentSlide = 0, carouselTotal = 0, touchStartX = null;
let readArticles = safeParse(localStorage.getItem('readArticles'), []);
let bookmarks = safeParse(localStorage.getItem('bookmarks'), []);

function safeParse(str, fallback) { try { const v = JSON.parse(str); return Array.isArray(v) ? v : fallback; } catch (e) { return fallback; } }

function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function isBanglaText(str) { return str ? /[\u0980-\u09FF]/.test(str) : false; }

function hashId(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) | 0;
    return 'c' + Math.abs(hash).toString(36);
}

const svgSun = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>`;
const svgMoon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>`;
const svgBookmarkEmpty = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg>`;
const svgBookmarkFilled = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg>`;
const svgShare = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>`;

function updateClock() {
    const now = new Date();
    const el = document.getElementById('live-datetime');
    if (el) el.innerText = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Dhaka' });
}
setInterval(updateClock, 60000); updateClock();

function setupThemeIcon() {
    const btn = document.getElementById('theme-btn');
    if (btn) btn.innerHTML = document.documentElement.getAttribute('data-theme') === 'dark' ? svgSun : svgMoon;
}
setupThemeIcon();

window.toggleTheme = function() {
    const t = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', t);
    localStorage.setItem('theme', t);
    setupThemeIcon();
}

window.toggleSearch = function() {
    const el = document.getElementById('search-container');
    if (!el) return;
    const show = el.style.display !== 'block';
    el.style.display = show ? 'block' : 'none';
    if (show) { document.getElementById('search-box').focus(); updateSearchClearBtn(); }
}

window.toggleModal = function(id) {
    const m = document.getElementById(id);
    if (m) m.style.display = 'flex';
}
const loginModal = document.getElementById('login-modal');
if (loginModal) loginModal.addEventListener('click', function(e) { if (e.target === this) this.style.display = 'none'; });

window.addEventListener('scroll', () => {
    const b = document.getElementById('back-to-top');
    if (b) b.style.display = window.scrollY > 300 ? 'flex' : 'none';
}, { passive: true });

/* Slide-In Filter Popover Handlers */
window.toggleFilterModal = function() {
    const modal = document.getElementById('filter-modal');
    if (!modal) return;
    if (modal.classList.contains('show')) closeFilterModal();
    else openFilterModal();
}

window.openFilterModal = function() {
    setupFilters();
    const modal = document.getElementById('filter-modal');
    if (modal) {
        modal.classList.add('show');
        document.body.style.overflow = 'hidden';
    }
}

window.closeFilterModal = function(e) {
    if (!e || e.target === document.getElementById('filter-modal') || (e.target && e.target.closest && e.target.closest('.close-filter-popover'))) {
        const modal = document.getElementById('filter-modal');
        if (modal) {
            modal.classList.remove('show');
            document.body.style.overflow = '';
        }
    }
}

window.toggleFilterAccordion = window.toggleFilterModal;

function showToast(m) {
    const t = document.getElementById('toast');
    if (t) { t.innerText = m; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2200); }
}

function getRelativeTime(dateStr) {
    if (!dateStr) return '';
    const d = Math.floor((new Date() - new Date(dateStr)) / 1000);
    if (d < 60) return "Just now";
    const m = Math.floor(d / 60);
    if (m < 60) return m + " min ago";
    const h = Math.floor(m / 60);
    if (h < 24) return h + " hr ago";
    const days = Math.floor(h / 24);
    return days === 1 ? "Yesterday" : days + " days ago";
}

function parseTags(item) {
    if (!item || !item.tags) return [];
    let raw = item.tags;
    if (Array.isArray(raw)) return raw.map(t => typeof t === 'string' ? t : (t && t.value) || (t && t.name) || null).filter(Boolean);
    if (typeof raw === 'string') {
        raw = raw.trim(); if (!raw) return [];
        try { const p = JSON.parse(raw.replace(/'/g, '"')); return Array.isArray(p) ? p.map(t => typeof t === 'string' ? t : (t && t.value) || (t && t.name) || null).filter(Boolean) : (typeof p === 'string' ? [p] : []); }
        catch (e) { const parts = raw.replace(/[\[\]{}"']/g, '').split(',').map(t => t.trim()).filter(Boolean); return parts.length ? parts : [raw]; }
    }
    return [];
}

function applyView(viewType) {
    if (window.innerWidth < 768) {
        if (viewType !== 'grid-1' && viewType !== 'grid-2' && viewType !== 'text') {
            viewType = 'grid-2';
        }
    }
    currentView = viewType;
    localStorage.setItem('newsView', viewType);
    const container = document.getElementById('news-container');
    if (container) container.className = 'layout-' + viewType;
    document.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', b.dataset.view === viewType));
    positionSegSlider();
    renderArticles();
}

function positionSegSlider() {
    const a = document.querySelector('.seg-btn.active'), s = document.getElementById('seg-slider');
    if (a && s && window.getComputedStyle(a).display !== 'none') { s.style.width = a.offsetWidth + 'px'; s.style.transform = 'translateX(' + a.offsetLeft + 'px)'; }
}
window.addEventListener('resize', positionSegSlider);

const layoutSeg = document.getElementById('layout-segmented');
if (layoutSeg) layoutSeg.addEventListener('click', e => { const b = e.target.closest('.seg-btn'); if (b) applyView(b.dataset.view); });

function updateSearchClearBtn() {
    const clearBtn = document.getElementById('search-clear-btn');
    const box = document.getElementById('search-box');
    if (clearBtn && box) clearBtn.style.display = box.value ? 'flex' : 'none';
}

window.clearSearch = function() {
    const box = document.getElementById('search-box');
    if (box) {
        box.value = '';
        updateSearchClearBtn();
        fetchPageNum = 1;
        hasMoreServerData = true;
        fetchArticlesFromWorker(true);
        box.focus();
    }
}

window.clearAllFilters = function() {
    activeCategories = ['All']; activeSources = ['All']; activeLanguages = ['All'];
    localStorage.setItem('newsCategories', JSON.stringify(['All']));
    localStorage.setItem('newsSources', JSON.stringify(['All']));
    localStorage.setItem('newsLanguages', JSON.stringify(['All']));
    fetchPageNum = 1;
    hasMoreServerData = true;
    setupFilters();
    fetchArticlesFromWorker(true);
    showToast("Filters cleared");
}

function computeContextualTags() {
    const tags = new Set();
    globalData.forEach(item => {
        const itemLang = isBanglaText(item.title) ? 'Bangla' : 'English';
        if (!activeLanguages.includes('All') && !activeLanguages.includes(itemLang)) return;
        const src = item.source_name || 'Unknown';
        if (!activeSources.includes('All') && !activeSources.includes(src)) return;
        parseTags(item).forEach(t => { if (t && t !== item.source_name) tags.add(t); });
    });
    return Array.from(tags).sort();
}

function computeContextualSources() {
    const sources = new Set();
    globalData.forEach(item => {
        const itemLang = isBanglaText(item.title) ? 'Bangla' : 'English';
        if (!activeLanguages.includes('All') && !activeLanguages.includes(itemLang)) return;
        if (!activeCategories.includes('All')) {
            const itemTags = parseTags(item);
            if (!activeCategories.some(cat => itemTags.includes(cat))) return;
        }
        if (item.source_name) sources.add(item.source_name);
    });
    return Array.from(sources).sort();
}

function setupFilters() {
    const contextualTags = computeContextualTags();
    const tagContainer = document.getElementById('filter-container');
    if (tagContainer) {
        tagContainer.innerHTML = '<button class="capsule ' + (activeCategories.includes('All') ? 'active' : '') + '" data-category="All">All topics</button>';
        contextualTags.forEach(cat => {
            tagContainer.innerHTML += '<button class="capsule ' + (activeCategories.includes(cat) ? 'active' : '') + '" data-category="' + escapeHtml(cat) + '">' + escapeHtml(cat) + '</button>';
        });
    }

    const contextualSources = computeContextualSources();
    const sourceContainer = document.getElementById('source-filter-container');
    if (sourceContainer) {
        sourceContainer.innerHTML = '<button class="capsule ' + (activeSources.includes('All') ? 'active' : '') + '" data-source="All">All sources</button>';
        contextualSources.forEach(src => {
            sourceContainer.innerHTML += '<button class="capsule ' + (activeSources.includes(src) ? 'active' : '') + '" data-source="' + escapeHtml(src) + '">' + escapeHtml(src) + '</button>';
        });
    }

    document.querySelectorAll('#lang-filter-container .capsule').forEach(btn => btn.classList.toggle('active', activeLanguages.includes(btn.dataset.lang)));
}

function handleMultiSelect(clickedVal, currentArray, allVal) {
    if (clickedVal === allVal) return [allVal];
    let next = currentArray.filter(v => v !== allVal);
    if (next.includes(clickedVal)) next = next.filter(v => v !== clickedVal);
    else next.push(clickedVal);
    return next.length === 0 ? [allVal] : next;
}

const filterCont = document.getElementById('filter-container');
if (filterCont) filterCont.addEventListener('click', e => {
    const btn = e.target.closest('.capsule'); if (!btn) return;
    activeCategories = handleMultiSelect(btn.dataset.category, activeCategories, 'All');
    localStorage.setItem('newsCategories', JSON.stringify(activeCategories));
    fetchPageNum = 1;
    hasMoreServerData = true;
    setupFilters();
    applyFiltersAndSort();
});

const sourceCont = document.getElementById('source-filter-container');
if (sourceCont) sourceCont.addEventListener('click', e => {
    const btn = e.target.closest('.capsule'); if (!btn) return;
    activeSources = handleMultiSelect(btn.dataset.source, activeSources, 'All');
    localStorage.setItem('newsSources', JSON.stringify(activeSources));
    fetchPageNum = 1;
    hasMoreServerData = true;
    setupFilters();
    applyFiltersAndSort();
});

const langCont = document.getElementById('lang-filter-container');
if (langCont) langCont.addEventListener('click', e => {
    const btn = e.target.closest('.capsule'); if (!btn) return;
    activeLanguages = handleMultiSelect(btn.dataset.lang, activeLanguages, 'All');
    localStorage.setItem('newsLanguages', JSON.stringify(activeLanguages));
    fetchPageNum = 1;
    hasMoreServerData = true;
    setupFilters();
    applyFiltersAndSort();
});

const searchBox = document.getElementById('search-box');
if (searchBox) searchBox.addEventListener('input', () => {
    updateSearchClearBtn();
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
        fetchPageNum = 1;
        hasMoreServerData = true;
        currentDisplayed = itemsPerPage;
        fetchArticlesFromWorker(true);
    }, 350);
});

const sortBox = document.getElementById('sort-box');
if (sortBox) sortBox.addEventListener('change', applyFiltersAndSort);

function loadFromCache() {
    const cachedTime = localStorage.getItem(CACHE_TIME_KEY);
    const cachedData = localStorage.getItem(CACHE_KEY);
    if (cachedTime && cachedData) {
        try {
            const data = JSON.parse(cachedData);
            if (data.length > 0) {
                globalData = data;
                setupFilters();
                renderTicker(globalData.slice(0, 12));
                currentDisplayed = itemsPerPage;
                applyFiltersAndSort();
                setTimeout(positionSegSlider, 50);
                return true;
            }
        } catch (e) { }
    }
    return false;
}

function updateSentinelLoader(show) {
    const sentinel = document.getElementById('scroll-sentinel');
    if (!sentinel) return;
    if (show && (isFetching || hasMoreServerData)) {
        sentinel.innerHTML = '<div class="sentinel-loader"><span class="ticker-dot"></span> Loading articles from Baserow...</div>';
    } else {
        sentinel.innerHTML = '';
    }
}

// ALWAYS fetches directly from Cloudflare Worker / Baserow proxy with active pagination
async function fetchArticlesFromWorker(force = false, isLoadMoreCall = false) {
    if (isFetching) return;
    const searchVal = document.getElementById('search-box');
    const searchTerm = searchVal ? searchVal.value.trim() : '';
    
    if (isLoadMoreCall && !hasMoreServerData) return;

    isFetching = true;
    updateSentinelLoader(true);

    try {
        const now = Date.now();

        if (!isLoadMoreCall && (force || globalData.length === 0)) {
            const cachedTime = localStorage.getItem(CACHE_TIME_KEY);
            if (!force && cachedTime && (now - Number(cachedTime) < CACHE_TTL) && !searchTerm) {
                setupFilters();
                renderTicker(globalData.slice(0, 12));
                currentDisplayed = itemsPerPage;
                applyFiltersAndSort();
                setTimeout(positionSegSlider, 50);
                isFetching = false;
                updateSentinelLoader(false);
                return;
            }
        }

        if (globalData.length === 0 && !isLoadMoreCall) renderSkeletons(8);

        // Build query parameters pointing to Worker proxy
        const queryParams = new URLSearchParams({ page: fetchPageNum.toString(), size: '50' });
        if (searchTerm) queryParams.append('search', searchTerm);

        const res = await fetch(API_WORKER_URL + '?' + queryParams.toString());
        
        if (res.ok) {
            const newData = await res.json();
            if (Array.isArray(newData) && newData.length > 0) {
                const existingUrls = new Set(globalData.map(item => item.url));
                let addedCount = 0;
                
                newData.forEach(item => {
                    if (item.url && !existingUrls.has(item.url)) {
                        globalData.push(item);
                        existingUrls.add(item.url);
                        addedCount++;
                    }
                });

                if (addedCount > 0) {
                    fetchPageNum++;
                }
                
                // If the worker returns fewer items than requested, we've reached the end of Baserow
                if (newData.length < 20) {
                    hasMoreServerData = false;
                }
            } else {
                hasMoreServerData = false;
            }
        } else {
            hasMoreServerData = false;
        }

        if (isLoadMoreCall) {
            currentDisplayed += itemsPerPage;
        }

        if (!searchTerm && globalData.length > 0) {
            try {
                localStorage.setItem(CACHE_KEY, JSON.stringify(globalData));
                localStorage.setItem(CACHE_TIME_KEY, now.toString());
            } catch (e) { }
        }

        if (globalData.length > 0) {
            setupFilters();
            renderTicker(globalData.slice(0, 12));
        } else {
            const ticker = document.getElementById('ticker-bar');
            if (ticker) ticker.style.display = 'none';
        }

        applyFiltersAndSort();
        setTimeout(positionSegSlider, 50);

    } catch (error) {
        console.error("Worker API Error:", error);
        const ticker = document.getElementById('ticker-bar');
        if (ticker) ticker.style.display = 'none';
        if (globalData.length === 0) renderErrorState();
    } finally {
        isFetching = false;
        updateSentinelLoader(false);
    }
}

function applyFiltersAndSort() {
    const sortEl = document.getElementById('sort-box');
    const sortMode = sortEl ? sortEl.value : 'newest';
    const searchEl = document.getElementById('search-box');
    const searchTerm = searchEl ? searchEl.value.trim().toLowerCase() : '';
    filteredData = [...globalData];

    if (sortMode === 'bookmarks') filteredData = filteredData.filter(item => bookmarks.includes(item.url));

    if (!activeLanguages.includes('All')) {
        filteredData = filteredData.filter(item => activeLanguages.includes(isBanglaText(item.title) ? 'Bangla' : 'English'));
    }
    if (!activeSources.includes('All')) {
        filteredData = filteredData.filter(item => activeSources.includes(item.source_name));
    }
    if (!activeCategories.includes('All')) {
        filteredData = filteredData.filter(item => {
            const tags = parseTags(item);
            return activeCategories.some(cat => tags.includes(cat));
        });
    }
    if (searchTerm) {
        filteredData = filteredData.filter(item => {
            const title = (item.title || '').toLowerCase();
            const summary = (item.summary || '').toLowerCase();
            const source = (item.source_name || '').toLowerCase();
            const tagStr = parseTags(item).map(t => t.toLowerCase()).join(' ');
            return title.includes(searchTerm) || summary.includes(searchTerm) || source.includes(searchTerm) || tagStr.includes(searchTerm);
        });
    }

    if (sortMode === 'oldest') filteredData.sort((a, b) => new Date(a.published_at || 0) - new Date(b.published_at || 0));
    else if (sortMode !== 'bookmarks') filteredData.sort((a, b) => new Date(b.published_at || 0) - new Date(a.published_at || 0));

    setupFilters();
    renderArticles();
}

// True Infinite Scroll Trigger: Expands local items or pulls fresh pages from Baserow
function infiniteScrollTrigger() {
    if (isFetching) return;

    if (currentDisplayed < filteredData.length) {
        // Show next batch from already-fetched memory
        currentDisplayed = Math.min(filteredData.length, currentDisplayed + itemsPerPage);
        renderArticles();
    } else if (hasMoreServerData) {
        // If local items run out, actively hit the Cloudflare Worker API for the next Baserow page
        fetchArticlesFromWorker(false, true);
    }
}

window.filterByTag = function(tag) {
    if (!activeCategories.includes(tag)) {
        activeCategories = [tag];
        localStorage.setItem('newsCategories', JSON.stringify(activeCategories));
        fetchPageNum = 1;
        hasMoreServerData = true;
        setupFilters();
        applyFiltersAndSort();
    }
    window.scrollTo({ top: 400, behavior: 'smooth' });
}

function markRead(url) {
    if (!readArticles.includes(url)) {
        readArticles.push(url);
        localStorage.setItem('readArticles', JSON.stringify(readArticles));
        const card = document.getElementById(hashId(url));
        if (card) card.classList.add('read');
    }
}

function toggleBookmark(url) {
    const nowSaved = !bookmarks.includes(url);
    bookmarks = nowSaved ? [...bookmarks, url] : bookmarks.filter(l => l !== url);
    localStorage.setItem('bookmarks', JSON.stringify(bookmarks));
    document.querySelectorAll('.bookmark-btn[data-url="' + cssEscape(url) + '"]').forEach(btn => {
        btn.innerHTML = nowSaved ? svgBookmarkFilled : svgBookmarkEmpty;
        btn.classList.toggle('saved', nowSaved);
    });
    const sortEl = document.getElementById('sort-box');
    if (sortEl && sortEl.value === 'bookmarks') applyFiltersAndSort();
}

window.handleShare = async function(title, url) {
    if (navigator.share && window.innerWidth < 1024) {
        try { await navigator.share({ title, url }); } catch (err) { if (err.name !== 'AbortError') fallbackCopyUrl(url); }
    } else fallbackCopyUrl(url);
}

function fallbackCopyUrl(url) { navigator.clipboard.writeText(url).then(() => showToast("Link copied to clipboard!")).catch(() => prompt("Copy link:", url)); }

function cssEscape(str) { return window.CSS && CSS.escape ? CSS.escape(str) : str.replace(/["\\]/g, '\\$&'); }

const newsCont = document.getElementById('news-container');
if (newsCont) newsCont.addEventListener('click', e => {
    const bk = e.target.closest('.bookmark-btn');
    if (bk) { e.preventDefault(); toggleBookmark(bk.dataset.url); return; }
    const sh = e.target.closest('.share-btn');
    if (sh) { e.preventDefault(); handleShare(sh.dataset.title, sh.dataset.url); return; }
    const tg = e.target.closest('.tag[data-tag]');
    if (tg) { e.preventDefault(); filterByTag(tg.dataset.tag); return; }
    const ln = e.target.closest('a[data-url]');
    if (ln) markRead(ln.dataset.url);
});

function buildCarouselHtml(items) {
    carouselTotal = items.length; currentSlide = 0;
    const slidesHtml = items.map((item, index) => {
        const bm = bookmarks.includes(item.url), st = item.source_name || 'News';
        const tt = parseTags(item).filter(t => t !== st && t !== 'Top News');
        const u = escapeHtml(item.url), ti = escapeHtml(item.title), bn = isBanglaText(item.title);
        const tagsHtml = ['<span class="tag" data-tag="' + escapeHtml(st) + '">' + escapeHtml(st) + '</span>', ...tt.map(t => '<span class="tag" data-tag="' + escapeHtml(t) + '">' + escapeHtml(t) + '</span>')].join('');
        return '<div class="carousel-slide ' + (index === 0 ? 'active' : '') + '" id="slide-' + index + '">'
            + '<span class="wire-stamp">Top story</span>'
            + '<a href="' + u + '" target="_blank" rel="noopener" data-url="' + u + '" class="hero-full-link" aria-label="' + ti + '"></a>'
            + '<div class="card-image-wrap">' + (item.image_url ? '<img src="' + escapeHtml(item.image_url) + '" class="news-image" alt="">' : '') + '<div class="hero-overlay"></div></div>'
            + '<div class="news-content"><div class="content-main"><div class="tags-group">' + tagsHtml + '</div>'
            + '<a class="news-title ' + (bn ? 'bn-title' : '') + '" href="' + u + '" target="_blank" rel="noopener" data-url="' + u + '">' + ti + '</a></div>'
            + '<div class="bookmark-wrap"><div style="display:flex; gap:4px;">'
            + '<button class="bookmark-btn ' + (bm ? 'saved' : '') + '" data-url="' + u + '" title="Save">' + (bm ? svgBookmarkFilled : svgBookmarkEmpty) + '</button>'
            + '<button class="share-btn" data-url="' + u + '" data-title="' + ti + '" title="Share">' + svgShare + '</button></div>'
            + '<div class="meta"><span>' + getRelativeTime(item.published_at) + '</span></div></div></div>'
            + '<div class="carousel-progress-bar"></div></div>';
    }).join('');
    const dotsHtml = items.map((_, i) => '<div class="dot ' + (i === 0 ? 'active' : '') + '" data-slide="' + i + '" id="dot-' + i + '"></div>').join('');
    return '<div class="hero-carousel" id="hero-carousel" onmouseenter="pauseCarousel()" onmouseleave="resumeCarousel()">' + slidesHtml
        + '<button class="carousel-nav prev" onclick="moveSlide(-1)">❮</button>'
        + '<button class="carousel-nav next" onclick="moveSlide(1)">❯</button>'
        + '<div class="carousel-dots">' + dotsHtml + '</div></div>';
}

window.moveSlide = function(step) {
    let ns = currentSlide + step;
    if (ns >= carouselTotal) ns = 0; if (ns < 0) ns = carouselTotal - 1;
    goToSlide(ns);
}

function goToSlide(index) {
    document.querySelectorAll('.carousel-slide').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.dot').forEach(d => d.classList.remove('active'));
    const slide = document.getElementById('slide-' + index), dot = document.getElementById('dot-' + index);
    if (slide) slide.classList.add('active'); if (dot) dot.classList.add('active');
    currentSlide = index;
    resetCarouselTimer();
}

function startCarouselTimer() {
    clearInterval(carouselInterval);
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) carouselInterval = setInterval(() => { moveSlide(1); }, 5000);
}

window.pauseCarousel = function() {
    clearInterval(carouselInterval);
    const ab = document.querySelector('.carousel-slide.active .carousel-progress-bar');
    if (ab) { ab.style.transition = 'none'; ab.style.width = window.getComputedStyle(ab).width; }
}

window.resumeCarousel = function() {
    const ab = document.querySelector('.carousel-slide.active .carousel-progress-bar');
    if (ab) {
        const cw = parseFloat(window.getComputedStyle(ab).width), pw = ab.parentElement.offsetWidth;
        ab.style.transition = 'width ' + (5000 * (1 - cw / pw)) + 'ms linear'; ab.style.width = '100%';
    }
    startCarouselTimer();
}

function resetCarouselTimer() {
    const ab = document.querySelector('.carousel-slide.active .carousel-progress-bar');
    if (ab) { ab.style.transition = 'none'; ab.style.width = '0%'; setTimeout(() => { ab.style.transition = 'width 5s linear'; ab.style.width = '100%'; }, 50); }
    startCarouselTimer();
}

function setupCarouselSwipe(el) {
    el.addEventListener('touchstart', e => { touchStartX = e.touches[0].clientX; }, { passive: true });
    el.addEventListener('touchend', e => {
        if (touchStartX === null) return;
        const delta = e.changedTouches[0].clientX - touchStartX;
        if (Math.abs(delta) > 40) moveSlide(delta < 0 ? 1 : -1);
        touchStartX = null;
    }, { passive: true });
}

function renderTicker(items) {
    const bar = document.getElementById('ticker-bar');
    if (!bar) return;
    if (!items.length) { bar.style.display = 'none'; return; }
    bar.style.display = 'flex';
    const headlines = items.map(item => '<a href="' + escapeHtml(item.url) + '" target="_blank" rel="noopener" data-url="' + escapeHtml(item.url) + '">' + escapeHtml(item.title) + '</a>').join('<span class="ticker-sep">&nbsp;•&nbsp;</span>');
    const track = document.getElementById('ticker-track');
    if (track) {
        track.innerHTML = headlines + '<span class="ticker-sep">&nbsp;•&nbsp;</span>' + headlines;
        track.querySelectorAll('a').forEach(a => a.addEventListener('click', () => markRead(a.dataset.url)));
    }
}

function buildCardHtml(item, index = 0) {
    const isRead = readArticles.includes(item.url), isBookmarked = bookmarks.includes(item.url);
    const cardId = hashId(item.url), snippet = item.summary || '', sourceTag = item.source_name || 'News';
    const topicTags = parseTags(item).filter(t => t !== sourceTag && t !== 'Top News');
    const url = escapeHtml(item.url), titleStr = escapeHtml(item.title), isBn = isBanglaText(item.title);
    const hasImage = Boolean(item.image_url), isMasonry = currentView === 'masonry';
    const spanClass = (isMasonry && (index % 5 === 0 || index % 7 === 1)) ? 'span-2' : '';
    const noImageCardClass = (!hasImage && isMasonry) ? 'no-image-card' : '';
    const imageHtml = hasImage
        ? '<a href="' + url + '" target="_blank" rel="noopener" data-url="' + url + '" class="card-image-wrap"><img src="' + escapeHtml(item.image_url) + '" alt="" class="news-image" loading="lazy"></a>'
        : (isMasonry ? '' : '<div class="card-image-wrap"><span class="no-image-placeholder">No image</span></div>');
    const allTagsHtml = ['<span class="tag" data-tag="' + escapeHtml(sourceTag) + '">' + escapeHtml(sourceTag) + '</span>',
        ...topicTags.map(t => '<span class="tag" data-tag="' + escapeHtml(t) + '">' + escapeHtml(t) + '</span>')].join('');

    if (!hasImage && isMasonry) {
        return '<div id="' + cardId + '" class="news-card ' + spanClass + ' ' + noImageCardClass + ' ' + (isRead ? 'read' : '') + '">'
            + '<div class="news-content"><div class="content-main">'
            + '<div class="card-header"><div class="tags-group">' + allTagsHtml + '</div>'
            + '<div class="card-actions-group">'
            + '<button class="bookmark-btn ' + (isBookmarked ? 'saved' : '') + '" data-url="' + url + '" title="Save">' + (isBookmarked ? svgBookmarkFilled : svgBookmarkEmpty) + '</button>'
            + '<button class="share-btn" data-url="' + url + '" data-title="' + titleStr + '" title="Share">' + svgShare + '</button></div></div>'
            + '<a class="news-title ' + (isBn ? 'bn-title' : '') + '" href="' + url + '" target="_blank" rel="noopener" data-url="' + url + '">' + titleStr + '</a>'
            + (snippet ? '<div class="snippet">' + escapeHtml(snippet) + '</div>' : '')
            + '<div class="meta"><span>' + getRelativeTime(item.published_at) + '</span></div></div></div></div>';
    }

    return '<div id="' + cardId + '" class="news-card ' + spanClass + ' ' + (isRead ? 'read' : '') + '">' + imageHtml
        + '<div class="news-content"><div class="content-main">'
        + '<div class="card-header"><div class="tags-group">' + allTagsHtml + '</div>'
        + '<div class="card-actions-group">'
        + '<button class="bookmark-btn ' + (isBookmarked ? 'saved' : '') + '" data-url="' + url + '" title="Save">' + (isBookmarked ? svgBookmarkFilled : svgBookmarkEmpty) + '</button>'
        + '<button class="share-btn" data-url="' + url + '" data-title="' + titleStr + '" title="Share">' + svgShare + '</button></div></div>'
        + '<a class="news-title ' + (isBn ? 'bn-title' : '') + '" href="' + url + '" target="_blank" rel="noopener" data-url="' + url + '">' + titleStr + '</a>'
        + (snippet ? '<div class="snippet">' + escapeHtml(snippet) + '</div>' : '')
        + '<div class="meta"><span>' + getRelativeTime(item.published_at) + '</span><div class="text-only-tags">' + allTagsHtml + '</div></div></div>'
        + '<div class="bookmark-wrap">'
        + '<button class="bookmark-btn ' + (isBookmarked ? 'saved' : '') + '" data-url="' + url + '" title="Save">' + (isBookmarked ? svgBookmarkFilled : svgBookmarkEmpty) + '</button>'
        + '<button class="share-btn" data-url="' + url + '" data-title="' + titleStr + '" title="Share">' + svgShare + '</button></div></div></div>';
}

function renderSkeletons(count) {
    let html = '';
    for (let i = 0; i < count; i++) html += '<div class="skeleton-card"><div class="skeleton-block skeleton-img"></div><div class="skeleton-block skeleton-line" style="width:85%"></div><div class="skeleton-block skeleton-line" style="width:60%"></div></div>';
    const container = document.getElementById('news-container');
    if (container) container.innerHTML = html;
}

function renderEmptyState() {
    const container = document.getElementById('news-container');
    if (container) container.innerHTML = '<div class="state-panel"><div class="state-title">No articles match these filters</div><div class="state-body">Try a different topic, source, or language — or clear your search.</div><button class="state-action" onclick="resetFilters()">Clear filters</button></div>';
}

function renderErrorState() {
    const container = document.getElementById('news-container');
    if (container) container.innerHTML = '<div class="state-panel"><div class="state-title">Couldn\'t load the feed</div><div class="state-body">The connection to the news source failed. Check your connection and try again.</div><button class="state-action" onclick="fetchArticlesFromWorker(true)">Retry</button></div>';
}

window.resetFilters = function() {
    activeCategories = ['All']; activeSources = ['All']; activeLanguages = ['All'];
    localStorage.setItem('newsCategories', JSON.stringify(['All']));
    localStorage.setItem('newsSources', JSON.stringify(['All']));
    localStorage.setItem('newsLanguages', JSON.stringify(['All']));
    const box = document.getElementById('search-box');
    if (box) box.value = '';
    const sortBox = document.getElementById('sort-box');
    if (sortBox) sortBox.value = 'newest';
    fetchPageNum = 1;
    hasMoreServerData = true;
    updateSearchClearBtn();
    setupFilters();
    applyFiltersAndSort();
}

function renderArticles() {
    const container = document.getElementById('news-container');
    if (!container) return;
    if (carouselInterval) clearInterval(carouselInterval);
    if (filteredData.length === 0) { renderEmptyState(); return; }

    let itemsToRender = filteredData.slice(0, currentDisplayed);
    let html = '';
    const showCarousel = currentView !== 'text';

    if (showCarousel && itemsToRender.length >= 3) {
        html += buildCarouselHtml(itemsToRender.slice(0, 3));
        itemsToRender.slice(3).forEach((item, idx) => html += buildCardHtml(item, idx));
    } else {
        itemsToRender.forEach((item, idx) => html += buildCardHtml(item, idx));
    }
    container.innerHTML = html;

    if (showCarousel && itemsToRender.length >= 3) {
        const carouselEl = document.getElementById('hero-carousel');
        if (carouselEl) {
            const dotsContainer = carouselEl.querySelector('.carousel-dots');
            if (dotsContainer) dotsContainer.addEventListener('click', e => { const dot = e.target.closest('.dot'); if (dot) goToSlide(Number(dot.dataset.slide)); });
            setupCarouselSwipe(carouselEl);
            startCarouselTimer();
        }
    }
}

/* Infinite Scroll IntersectionObserver */
const scrollObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting && !isFetching) {
            infiniteScrollTrigger();
        }
    });
}, { rootMargin: '200px' });

const sentinel = document.getElementById('scroll-sentinel');
if (sentinel) scrollObserver.observe(sentinel);

/* Initialize App */
applyView(currentView);
const cacheHit = loadFromCache();
fetchArticlesFromWorker(cacheHit ? false : true);
setInterval(() => { if (!document.hidden) fetchArticlesFromWorker(true); }, 3 * 60 * 1000);
