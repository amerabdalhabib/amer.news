// Initialization logic executed early to set dark/light theme instantly
const savedTheme = localStorage.getItem('theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
document.documentElement.setAttribute('data-theme', savedTheme);

const API_WORKER_URL = 'https://amernewsapi.amerhabib.workers.dev/';

/*
 * Manual customization options
 * -----------------------------
 * Update these arrays when you add a new language, topic, or source.
 * The values should match the language/topic/source values stored by the
 * Worker/Baserow data as closely as possible because they are also sent to
 * the API and used by the client-side filter.
 */
const MANUAL_FILTER_OPTIONS = Object.freeze({
    languages: ['English', 'Bangla'],
    topics: [
        'Top News',
        'Bangladesh',
        'World',
        'Politics',
        'Business',
        'Technology',
        'Sports',
        'Entertainment',
        'Health',
        'Science'
    ],
    sources: [
        { name: 'Al Jazeera', language: 'English' },
        { name: 'Amar Bangla', language: 'Bangla' },
        { name: 'Bangla Tribune', language: 'Bangla' },
        { name: 'BBC', language: 'English' },
        { name: 'Dawn', language: 'English' },
        { name: 'JagoNews24', language: 'Bangla' },
        { name: 'Prothom Alo', language: 'Bangla' },
        { name: 'RisingBD', language: 'Bangla' },
        { name: 'RT', language: 'English' },
        { name: 'The Business Standard', language: 'English' },
        { name: 'The Daily Star', language: 'English' },
        { name: 'The Guardian', language: 'English' },
        { name: 'The Times of India', language: 'English' }
    ]
});

let globalData = [];
let filteredData = [];
const itemsPerPage = 24; // Articles rendered per UI chunk
const serverPageSize = 50; // Rows requested from the Worker on every API load
let currentDisplayed = itemsPerPage;

const CACHE_KEY = 'amernews_data';
const CACHE_TIME_KEY = 'amernews_time';
const CACHE_PAGE_KEY = 'amernews_page';
const CACHE_TTL = 3 * 60 * 1000;

let isFetching = false;
let fetchPageNum = 1;          // Next server page to request
let hasMoreServerData = true;  // Whether the current API query has another page
let feedQueryKey = '';
let activeRequestId = 0;
let pendingFeedRequest = false;
let activeAbortController = null;
let cacheWriteTimer = null;

let activeCategories = safeParse(localStorage.getItem('newsCategories'), ['All']);
let activeSources = safeParse(localStorage.getItem('newsSources'), ['All']);
let activeLanguages = safeParse(localStorage.getItem('newsLanguages'), ['All']);
let currentView = localStorage.getItem('newsView') || (window.innerWidth < 768 ? 'grid-2' : 'grid-4');
let searchDebounce = null;

let carouselInterval, currentSlide = 0, carouselTotal = 0, touchStartX = null;
let readArticles = safeParse(localStorage.getItem('readArticles'), []);
let bookmarks = safeParse(localStorage.getItem('bookmarks'), []);

function normalizeActiveSelections() {
    const validSources = new Set(MANUAL_FILTER_OPTIONS.sources.map(source => source.name));
    const validLanguages = new Set(MANUAL_FILTER_OPTIONS.languages);

    // Topics are intentionally disabled in the Customize Feed controls.
    activeCategories = ['All'];
    localStorage.setItem('newsCategories', JSON.stringify(activeCategories));
    activeSources = activeSources.filter(value => value === 'All' || validSources.has(value));
    activeLanguages = activeLanguages.filter(value => value === 'All' || validLanguages.has(value));

    const visibleSourceNames = new Set(getSourcesForSelectedLanguages().map(source => source.name));
    activeSources = activeSources.filter(value => value === 'All' || visibleSourceNames.has(value));

    if (!activeCategories.length) activeCategories = ['All'];
    if (!activeSources.length) activeSources = ['All'];
    if (!activeLanguages.length) activeLanguages = ['All'];
}

function getSourcesForSelectedLanguages() {
    if (activeLanguages.includes('All')) return MANUAL_FILTER_OPTIONS.sources;
    return MANUAL_FILTER_OPTIONS.sources.filter(source => activeLanguages.includes(source.language));
}

function normalizeArticle(raw) {
    const article = raw || {};
    const normalizedTags = parseTags(article);
    const title = article.title || '';
    const summary = article.summary || '';
    const source = article.source_name || 'Unknown';
    return {
        ...article,
        normalizedTags,
        language: isBanglaText(title) ? 'Bangla' : 'English',
        source,
        searchText: [title, summary, source, ...normalizedTags].join(' ').toLowerCase()
    };
}

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

function announceStatus(message) {
    const status = document.getElementById('news-status');
    if (status) status.textContent = message;
}

function getRelativeTime(dateStr) {
    if (!dateStr) return '';
    const publishedDate = new Date(dateStr);
    if (Number.isNaN(publishedDate.getTime())) return '';
    const d = Math.floor((new Date() - publishedDate) / 1000);
    if (d < 60) return "Just now";
    const m = Math.floor(d / 60);
    if (m < 60) return m + " min ago";
    const h = Math.floor(m / 60);
    if (h < 24) return h + " hr ago";
    const days = Math.floor(h / 24);
    if (days > 7) {
        return publishedDate.toLocaleString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit'
        });
    }
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
        fetchArticlesFromWorker({ reason: 'search', reset: true });
        box.focus();
    }
}

window.clearAllFilters = function() {
    activeCategories = ['All']; activeSources = ['All']; activeLanguages = ['All'];
    localStorage.setItem('newsCategories', JSON.stringify(['All']));
    localStorage.setItem('newsSources', JSON.stringify(['All']));
    localStorage.setItem('newsLanguages', JSON.stringify(['All']));
    setupFilters();
    fetchArticlesFromWorker({ reason: 'filter', reset: true });
    showToast("Filters cleared");
}

function setupFilters() {
    normalizeActiveSelections();
    const languageContainer = document.getElementById('lang-filter-container');
    if (languageContainer) {
        languageContainer.innerHTML = '<button class="capsule ' + (activeLanguages.includes('All') ? 'active' : '') + '" data-lang="All">Both</button>'
            + MANUAL_FILTER_OPTIONS.languages.map(language =>
                '<button class="capsule ' + (activeLanguages.includes(language) ? 'active' : '') + '" data-lang="' + escapeHtml(language) + '">' + escapeHtml(language) + '</button>'
            ).join('');
    }

    const tagContainer = document.getElementById('filter-container');
    if (tagContainer) {
        tagContainer.innerHTML = '<button class="capsule ' + (activeCategories.includes('All') ? 'active' : '') + '" data-category="All">All topics</button>';
        tagContainer.innerHTML += MANUAL_FILTER_OPTIONS.topics.map(topic =>
            '<button class="capsule ' + (activeCategories.includes(topic) ? 'active' : '') + '" data-category="' + escapeHtml(topic) + '">' + escapeHtml(topic) + '</button>'
        ).join('');
    }

    const sourceContainer = document.getElementById('source-filter-container');
    if (sourceContainer) {
        sourceContainer.innerHTML = '<button class="capsule ' + (activeSources.includes('All') ? 'active' : '') + '" data-source="All">All sources</button>';
        sourceContainer.innerHTML += getSourcesForSelectedLanguages().map(source =>
            '<button class="capsule ' + (activeSources.includes(source.name) ? 'active' : '') + '" data-source="' + escapeHtml(source.name) + '">' + escapeHtml(source.name) + '</button>'
        ).join('');
    }

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
    setupFilters();
    fetchArticlesFromWorker({ reason: 'filter', reset: true });
});

const sourceCont = document.getElementById('source-filter-container');
if (sourceCont) sourceCont.addEventListener('click', e => {
    const btn = e.target.closest('.capsule'); if (!btn) return;
    activeSources = handleMultiSelect(btn.dataset.source, activeSources, 'All');
    localStorage.setItem('newsSources', JSON.stringify(activeSources));
    setupFilters();
    fetchArticlesFromWorker({ reason: 'filter', reset: true });
});

const langCont = document.getElementById('lang-filter-container');
if (langCont) langCont.addEventListener('click', e => {
    const btn = e.target.closest('.capsule'); if (!btn) return;
    activeLanguages = handleMultiSelect(btn.dataset.lang, activeLanguages, 'All');
    localStorage.setItem('newsLanguages', JSON.stringify(activeLanguages));
    setupFilters();
    fetchArticlesFromWorker({ reason: 'filter', reset: true });
});

const searchBox = document.getElementById('search-box');
if (searchBox) searchBox.addEventListener('input', () => {
    updateSearchClearBtn();
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
        fetchArticlesFromWorker({ reason: 'search', reset: true });
    }, 350);
});

const sortBox = document.getElementById('sort-box');
if (sortBox) sortBox.addEventListener('change', applyFiltersAndSort);

function getSearchTerm() {
    const box = document.getElementById('search-box');
    return box ? box.value.trim() : '';
}

function getFeedQueryKey() {
    return JSON.stringify({
        search: getSearchTerm().toLowerCase(),
        categories: [...activeCategories].sort(),
        sources: [...activeSources].sort(),
        languages: [...activeLanguages].sort()
    });
}

function isDefaultFeedQuery() {
    return !getSearchTerm() && activeCategories.includes('All') && activeSources.includes('All') && activeLanguages.includes('All');
}

function resetFeedSession() {
    globalData = [];
    filteredData = [];
    fetchPageNum = 1;
    hasMoreServerData = true;
    currentDisplayed = 0;
    feedQueryKey = getFeedQueryKey();
    activeRequestId++;
}

function addArticles(items) {
    const knownUrls = new Set(globalData.map(item => item.url).filter(Boolean));
    let added = 0;
    items.forEach(item => {
        if (!item || !item.url || knownUrls.has(item.url)) return;
        globalData.push(normalizeArticle(item));
        knownUrls.add(item.url);
        added++;
    });
    return added;
}

function scheduleCacheWrite() {
    if (!isDefaultFeedQuery() || !globalData.length) return;
    clearTimeout(cacheWriteTimer);
    cacheWriteTimer = setTimeout(() => {
        const write = () => {
            try {
                localStorage.setItem(CACHE_KEY, JSON.stringify(globalData));
                localStorage.setItem(CACHE_TIME_KEY, String(Date.now()));
                localStorage.setItem(CACHE_PAGE_KEY, String(fetchPageNum));
            } catch (error) {
                console.warn('Unable to update article cache:', error);
            }
        };
        if ('requestIdleCallback' in window) requestIdleCallback(write, { timeout: 1000 });
        else write();
    }, 250);
}

function loadFromCache() {
    if (!isDefaultFeedQuery()) return false;
    const cachedTime = Number(localStorage.getItem(CACHE_TIME_KEY));
    const cachedData = localStorage.getItem(CACHE_KEY);
    if (!cachedTime || !cachedData || Date.now() - cachedTime > CACHE_TTL) return false;

    try {
        const data = JSON.parse(cachedData);
        if (!Array.isArray(data) || data.length === 0) return false;
        globalData = data.filter(item => item && item.url).map(normalizeArticle);
        fetchPageNum = Math.max(1, Number(localStorage.getItem(CACHE_PAGE_KEY)) || Math.floor(globalData.length / serverPageSize) + 1);
        currentDisplayed = Math.min(itemsPerPage, globalData.length);
        feedQueryKey = getFeedQueryKey();
        setupFilters();
        renderTicker(globalData.slice(0, 12));
        applyFiltersAndSort();
        setTimeout(positionSegSlider, 50);
        return true;
    } catch (error) {
        localStorage.removeItem(CACHE_KEY);
        localStorage.removeItem(CACHE_TIME_KEY);
        localStorage.removeItem(CACHE_PAGE_KEY);
        return false;
    }
}

function updateSentinelLoader(show) {
    const sentinel = document.getElementById('scroll-sentinel');
    if (!sentinel) return;
    // Keep the sentinel layout-only. The Load More button is the single visible
    // loading control; rendering a second loader here made infinite scroll look
    // like it had another Load More option.
    sentinel.innerHTML = '';
    sentinel.setAttribute('aria-busy', show ? 'true' : 'false');
}

function updateLoadMoreButton() {
    const container = document.getElementById('load-more-container');
    const btn = document.getElementById('load-more-btn');
    const text = document.getElementById('load-more-text');
    const spinner = document.getElementById('load-more-spinner');
    if (!container) return;

    const showButton = hasMoreServerData && globalData.length > 0;
    if (showButton || isFetching) {
        container.style.display = 'block';
        if (btn) btn.disabled = isFetching;
        if (text) {
            text.style.display = 'inline';
            text.textContent = isFetching ? 'Loading articles...' : 'Load more articles';
        }
        if (spinner) spinner.style.display = isFetching ? 'inline-block' : 'none';
    } else {
        container.style.display = 'none';
    }
}

window.loadMoreFromApi = async function() {
    await fetchArticlesFromWorker({ reason: 'button' });
}

function renderArticlesProgressively() {
    const container = document.getElementById('news-container');
    if (!container) return;
    if (filteredData.length === 0) {
        renderEmptyState();
        return;
    }

    const targetCount = filteredData.length;

    // Keep the hero carousel, if enabled, as the first three articles. Once it
    // exists, append every subsequent article independently instead of waiting
    // for a 20/24-item render batch.
    if (currentDisplayed === 0) {
        if (currentView !== 'text' && targetCount >= 3) {
            currentDisplayed = 3;
            renderArticles();
        } else {
            container.innerHTML = '';
        }
    }

    const appendNext = () => {
        if (currentDisplayed >= targetCount) {
            announceStatus('Loaded ' + currentDisplayed + ' articles');
            updateLoadMoreButton();
            return;
        }
        const fragment = document.createDocumentFragment();
        const template = document.createElement('template');
        let addedThisFrame = 0;
        while (currentDisplayed < targetCount && addedThisFrame < 4) {
            const itemIndex = currentDisplayed;
            template.innerHTML = buildCardHtml(filteredData[itemIndex], itemIndex);
            fragment.appendChild(template.content.firstElementChild);
            currentDisplayed++;
            addedThisFrame++;
        }
        container.appendChild(fragment);
        window.requestAnimationFrame(appendNext);
    };
    appendNext();
}

// Every call in this function, including infinite scroll and Load More, goes to the API.
async function fetchArticlesFromWorker(options = {}) {
    if (typeof options === 'boolean') {
        options = { reason: 'refresh', reset: options };
    }
    const { reason = 'refresh', reset = false } = options;
    const queryKey = getFeedQueryKey();
    if (reset || queryKey !== feedQueryKey) resetFeedSession();
    if (isFetching) {
        activeAbortController?.abort();
        pendingFeedRequest = true;
        return false;
    }
    if (!hasMoreServerData && reason !== 'refresh') return false;

    const requestId = activeRequestId;
    activeAbortController = new AbortController();
    isFetching = true;
    updateSentinelLoader(true);
    updateLoadMoreButton();
    if (globalData.length === 0) renderSkeletons(8);

    try {
        let totalAdded = 0;
        let lastPageSize = 0;
        let fetchedAtLeastOnePage = false;

        // Fetch one server page at a time. Matching articles are progressively
        // inserted as soon as the page arrives. For customized queries, keep
        // walking API pages until a match is found because the Worker may not
        // apply source/topic parameters server-side.
        while (hasMoreServerData && (!fetchedAtLeastOnePage || (!isDefaultFeedQuery() && filteredData.length === 0))) {
            const params = new URLSearchParams({ page: String(fetchPageNum), size: String(serverPageSize) });
            const searchTerm = getSearchTerm();
            if (searchTerm) params.set('search', searchTerm);
            else if (!activeSources.includes('All') && activeSources.length === 1) {
                // The Worker currently ignores `source`, but its search index
                // includes source_name. Use it to avoid walking many unrelated
                // pages for a single-source customization; client filtering
                // below still verifies the exact source.
                params.set('search', activeSources[0]);
            }
            // These are useful when supported by the Worker; client-side filtering below remains authoritative.
            if (!activeCategories.includes('All')) params.set('category', activeCategories.join(','));
            if (!activeSources.includes('All')) params.set('source', activeSources.join(','));
            if (!activeLanguages.includes('All')) params.set('language', activeLanguages.join(','));

            const response = await fetch(API_WORKER_URL + '?' + params.toString(), { cache: 'no-store', signal: activeAbortController.signal });
            if (!response.ok) throw new Error('API returned HTTP ' + response.status);
            const page = await response.json();
            if (requestId !== activeRequestId) return false;

            const rows = Array.isArray(page) ? page : [];
            fetchedAtLeastOnePage = true;
            lastPageSize = rows.length;
            const addedCount = addArticles(rows);
            totalAdded += addedCount;
            fetchPageNum += 1;
            hasMoreServerData = rows.length === serverPageSize && addedCount > 0;

            // Recalculate the result set without rebuilding the DOM for every
            // API page. The complete render happens once after the batch ends.
            applyFiltersAndSort(false);
            if (!rows.length || (addedCount === 0 && rows.length === serverPageSize)) break;
        }

        scheduleCacheWrite();
        if (globalData.length > 0) {
            renderTicker(globalData.slice(0, 12));
        } else if (!hasMoreServerData) {
            const ticker = document.getElementById('ticker-bar');
            if (ticker) ticker.style.display = 'none';
        }
        applyFiltersAndSort(false);
        renderArticlesProgressively();
        updateLoadMoreButton();
        setTimeout(positionSegSlider, 50);
        return totalAdded > 0 || lastPageSize > 0;
    } catch (error) {
        if (error.name !== 'AbortError') console.error('Worker API Error:', error);
        if (error.name !== 'AbortError' && globalData.length === 0) renderErrorState();
        return false;
    } finally {
        activeAbortController = null;
        isFetching = false;
        updateSentinelLoader(false);
        updateLoadMoreButton();
        if (pendingFeedRequest) {
            pendingFeedRequest = false;
            fetchArticlesFromWorker({ reason: 'queued' });
        }
    }
}

function applyFiltersAndSort(render = true) {
    const sortEl = document.getElementById('sort-box');
    const sortMode = sortEl ? sortEl.value : 'newest';
    const searchEl = document.getElementById('search-box');
    const searchTerm = searchEl ? searchEl.value.trim().toLowerCase() : '';
    filteredData = [...globalData];

    if (sortMode === 'bookmarks') filteredData = filteredData.filter(item => bookmarks.includes(item.url));

    if (!activeLanguages.includes('All')) {
        filteredData = filteredData.filter(item => activeLanguages.includes(item.language || (isBanglaText(item.title) ? 'Bangla' : 'English')));
    }
    if (!activeSources.includes('All')) {
        filteredData = filteredData.filter(item => activeSources.includes(item.source || item.source_name));
    }
    if (!activeCategories.includes('All')) {
        filteredData = filteredData.filter(item => {
            const tags = item.normalizedTags || parseTags(item);
            return activeCategories.some(cat => tags.includes(cat));
        });
    }
    if (searchTerm) {
        filteredData = filteredData.filter(item => {
            return (item.searchText || normalizeArticle(item).searchText).includes(searchTerm);
        });
    }

    if (sortMode === 'oldest') filteredData.sort((a, b) => new Date(a.published_at || 0) - new Date(b.published_at || 0));
    else if (sortMode !== 'bookmarks') filteredData.sort((a, b) => new Date(b.published_at || 0) - new Date(a.published_at || 0));

    if (render) {
        setupFilters();
        renderArticles();
        updateLoadMoreButton();
    }
}

// True Infinite Scroll Trigger: Expands local items or pulls fresh pages from Baserow
function infiniteScrollTrigger() {
    if (isFetching) return;
    if (hasMoreServerData) fetchArticlesFromWorker({ reason: 'infinite' });
}

window.filterByTag = function(tag) {
    if (!activeCategories.includes(tag)) {
        activeCategories = [tag];
        localStorage.setItem('newsCategories', JSON.stringify(activeCategories));
        setupFilters();
        fetchArticlesFromWorker({ reason: 'tag', reset: true });
    }
    window.scrollTo({ top: 400, behavior: 'smooth' });
}

window.filterBySource = function(sourceName) {
    const source = MANUAL_FILTER_OPTIONS.sources.find(item => item.name === sourceName);
    // Card data may contain a source that has not yet been added to the
    // manually maintained options list. The exact API source value should
    // still be selectable from the card; metadata is only needed for the
    // optional language reconciliation below.
    activeSources = [sourceName];
    if (source && !activeLanguages.includes('All') && !activeLanguages.includes(source.language)) {
        activeLanguages = [source.language];
        localStorage.setItem('newsLanguages', JSON.stringify(activeLanguages));
    }
    localStorage.setItem('newsSources', JSON.stringify(activeSources));
    setupFilters();
    fetchArticlesFromWorker({ reason: 'source-tag', reset: true });
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
    const sourceTag = e.target.closest('.tag[data-source]');
    if (sourceTag) { e.preventDefault(); filterBySource(sourceTag.dataset.source); return; }
    const tg = e.target.closest('.tag[data-tag]');
    if (tg) { e.preventDefault(); filterByTag(tg.dataset.tag); return; }
    const ln = e.target.closest('a[data-url]');
    if (ln) markRead(ln.dataset.url);
});

function buildCarouselHtml(items) {
    carouselTotal = items.length; currentSlide = 0;
    const slidesHtml = items.map((item, index) => {
        const bm = bookmarks.includes(item.url), st = item.source_name || 'News';
        const sourceClass = ['guardian', 'the guardian'].includes(st.trim().toLowerCase()) ? 'source-guardian' : '';
        const tt = parseTags(item).filter(t => t !== st && t !== 'Top News');
        const u = escapeHtml(item.url), ti = escapeHtml(item.title), bn = isBanglaText(item.title);
        const tagsHtml = ['<span class="tag" data-source="' + escapeHtml(st) + '">' + escapeHtml(st) + '</span>', ...tt.map(t => '<span class="tag" data-tag="' + escapeHtml(t) + '">' + escapeHtml(t) + '</span>')].join('');
        return '<div class="carousel-slide ' + sourceClass + ' ' + (index === 0 ? 'active' : '') + '" id="slide-' + index + '">'
            + '<span class="wire-stamp">Top story</span>'
            + '<a href="' + u + '" target="_blank" rel="noopener" data-url="' + u + '" class="hero-full-link" aria-label="' + ti + '"></a>'
            + '<div class="card-image-wrap">' + (item.image_url ? '<img src="' + escapeHtml(item.image_url) + '" class="news-image" alt="" loading="lazy" decoding="async">' : '') + '<div class="hero-overlay"></div></div>'
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
    const sourceClass = ['guardian', 'the guardian'].includes(sourceTag.trim().toLowerCase()) ? 'source-guardian' : '';
    const topicTags = parseTags(item).filter(t => t !== sourceTag && t !== 'Top News');
    const url = escapeHtml(item.url), titleStr = escapeHtml(item.title), isBn = isBanglaText(item.title);
    const hasImage = Boolean(item.image_url), isMasonry = currentView === 'masonry';
    const spanClass = (isMasonry && (index % 5 === 0 || index % 7 === 1)) ? 'span-2' : '';
    const noImageCardClass = (!hasImage && isMasonry) ? 'no-image-card' : '';
    const imageHtml = hasImage
        ? '<a href="' + url + '" target="_blank" rel="noopener" data-url="' + url + '" class="card-image-wrap"><img src="' + escapeHtml(item.image_url) + '" alt="" class="news-image" loading="lazy" decoding="async"></a>'
        : (isMasonry ? '' : '<div class="card-image-wrap"><span class="no-image-placeholder">No image</span></div>');
    const allTagsHtml = ['<span class="tag" data-source="' + escapeHtml(sourceTag) + '">' + escapeHtml(sourceTag) + '</span>',
        ...topicTags.map(t => '<span class="tag" data-tag="' + escapeHtml(t) + '">' + escapeHtml(t) + '</span>')].join('');

    if (!hasImage && isMasonry) {
        return '<div id="' + cardId + '" class="news-card ' + sourceClass + ' ' + spanClass + ' ' + noImageCardClass + ' ' + (isRead ? 'read' : '') + '">'
            + '<div class="news-content"><div class="content-main">'
            + '<div class="card-header"><div class="tags-group">' + allTagsHtml + '</div>'
            + '<div class="card-actions-group">'
            + '<button class="bookmark-btn ' + (isBookmarked ? 'saved' : '') + '" data-url="' + url + '" title="Save">' + (isBookmarked ? svgBookmarkFilled : svgBookmarkEmpty) + '</button>'
            + '<button class="share-btn" data-url="' + url + '" data-title="' + titleStr + '" title="Share">' + svgShare + '</button></div></div>'
            + '<a class="news-title ' + (isBn ? 'bn-title' : '') + '" href="' + url + '" target="_blank" rel="noopener" data-url="' + url + '">' + titleStr + '</a>'
            + (snippet ? '<div class="snippet">' + escapeHtml(snippet) + '</div>' : '')
            + '<div class="meta"><span>' + getRelativeTime(item.published_at) + '</span></div></div></div></div>';
    }

    return '<div id="' + cardId + '" class="news-card ' + sourceClass + ' ' + spanClass + ' ' + (isRead ? 'read' : '') + '">' + imageHtml
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
    if (container) container.innerHTML = '<div class="state-panel"><div class="state-title">Couldn\'t load the feed</div><div class="state-body">The connection to the news source failed. Check your connection and try again.</div><button class="state-action" onclick="fetchArticlesFromWorker({reset:true})">Retry</button></div>';
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
    updateSearchClearBtn();
    setupFilters();
    fetchArticlesFromWorker({ reason: 'reset', reset: true });
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
fetchArticlesFromWorker({ reason: cacheHit ? 'cache-follow-up' : 'initial', reset: !cacheHit });
setInterval(() => {
    // Never replace the active feed while the reader is deep in the page.
    // A background reset used to clear the loaded list and move the viewport.
    if (!document.hidden && window.scrollY < 300) {
        fetchArticlesFromWorker({ reason: 'refresh', reset: true });
    }
}, 3 * 60 * 1000);
