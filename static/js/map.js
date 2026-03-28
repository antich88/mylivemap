const bootstrapScript = document.getElementById('live-map-bootstrap');
const bootstrapData = bootstrapScript ? JSON.parse(bootstrapScript.textContent) : {};
const defaults = bootstrapData.defaults || { lat: 55.75, lng: 37.61, zoom: 13 };
const categoriesScript = document.getElementById('category-definitions');
const categoriesData = categoriesScript ? JSON.parse(categoriesScript.textContent) : [];
const allCategorySlugs = categoriesData.map((group) => group.slug).filter(Boolean);
const activeMarkers = [];
const activeCategorySlugs = new Set(allCategorySlugs);
const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
const LIVE_MAP_USER_ID_STORAGE_KEY = 'liveMapUserId';
const SHOW_ALL_MODES = { ALL: 'all', OFF: 'off' };
const AUTO_REFRESH_INTERVAL = 60_000;
const COMMENT_POLL_INTERVAL = 6_000;
const USER_MARKER_LIMIT = 5;
const baseStrokeOpacity = 0.9;
const baseFillOpacity = 0.6;
const MOBILE_BREAKPOINT_PX = 768;
const USER_LIMIT_MESSAGE = 'Вы достигли лимита в 5 меток. Пожалуйста, удалите старую или дождитесь её исчезновения.';
const POPUP_REOPEN_GUARD_MS = 200;
const COMMENT_MAX_LENGTH = 500;
const DEBUG_FILTER_PANEL = false;

window.currentCreationMarker = null;
window.userLocationMarker = null;
let userLocationIcon = null;
let map;
let pendingSharedPinToken = null;
let creationSelection = getDefaultCreationSelection();
let touchStartY = null;
let showAllMode = SHOW_ALL_MODES.OFF;
let showAllBtn = null;
let refreshBtn = null;
let autoRefreshTimerId = null;
let refreshInFlightPromise = null;
const commentPollers = new Map();
const commentStateCache = new Map();
const commentScrollState = new Map();
let categoryChips = [];
let userToastTimeoutId = null;
let lastNonCreationPopupCloseAt = 0;
let filterPanelElement = null;
let filterPanelMinimizeDepth = 0;
let currentAuthUser = bootstrapData.current_user || null;
let authToggleBtn = null;
let authPanelElement = null;
let authPanelVisible = false;
const AUTH_MODES = {
  LOGIN: 'login',
  REGISTER: 'register',
};
const PROFILE_GENDER_LABELS = {
  M: 'Мужской',
  F: 'Женский',
  X: 'Другое',
};
let currentAuthMode = AUTH_MODES.LOGIN;
let resetProfileToViewMode = null;

function ensureProfileViewMode() {
  if (typeof resetProfileToViewMode === 'function') {
    resetProfileToViewMode();
  }
}


function getFilterPanelElement() {
  if (filterPanelElement && filterPanelElement.isConnected) {
    return filterPanelElement;
  }
  filterPanelElement = document.querySelector('.filter-panel');
  return filterPanelElement;
}

function logFilterPanelState(stage, extra = {}) {
  if (!DEBUG_FILTER_PANEL) {
    return;
  }
  const panel = getFilterPanelElement();
  if (!panel) {
    console.debug('[filter-panel-debug]', { stage, panelFound: false, ...extra });
    return;
  }
  const computed = window.getComputedStyle(panel);
  const chips = panel.querySelector('.category-chips');
  const chipsComputed = chips ? window.getComputedStyle(chips) : null;
  console.debug('[filter-panel-debug]', {
    stage,
    panelFound: true,
    classes: Array.from(panel.classList),
    minimizeDepth: filterPanelMinimizeDepth,
    panelPointerEvents: computed.pointerEvents,
    panelVisibility: computed.visibility,
    panelOpacity: computed.opacity,
    panelDisplay: computed.display,
    chipsPointerEvents: chipsComputed?.pointerEvents,
    chipsVisibility: chipsComputed?.visibility,
    chipsOpacity: chipsComputed?.opacity,
    ...extra,
  });
}

function isMobileViewport() {
  return window.innerWidth < MOBILE_BREAKPOINT_PX;
}

function expandFilterPanel() {
  const panel = getFilterPanelElement();
  if (!panel) {
    return;
  }
  panel.classList.remove('collapsed');
  panel.classList.remove('minimized');
}

function minimizeFilterPanelForMobile(reason = 'generic') {
  if (!isMobileViewport()) {
    return;
  }
  const panel = getFilterPanelElement();
  if (!panel) {
    return;
  }
  logFilterPanelState('before-minimize', { reason });
  filterPanelMinimizeDepth = Math.max(0, filterPanelMinimizeDepth) + 1;
  panel.dataset.minimizeReason = reason;
  panel.classList.add('minimized');
  logFilterPanelState('after-minimize', { reason });
}

function releaseFilterPanelForMobile() {
  const panel = getFilterPanelElement();
  if (!panel) {
    return;
  }
  logFilterPanelState('before-release');
  filterPanelMinimizeDepth = Math.max(0, filterPanelMinimizeDepth - 1);
  if (filterPanelMinimizeDepth === 0) {
    delete panel.dataset.minimizeReason;
    panel.classList.remove('minimized');
  }
  logFilterPanelState('after-release');
}

function minimizeFilterPanelForCreation() {
  minimizeFilterPanelForMobile('creation');
}

function restoreFilterPanelAfterCreation() {
  releaseFilterPanelForMobile();
}

function minimizeFilterPanelForPinPopup() {
  minimizeFilterPanelForMobile('pin-popup');
}

function restoreFilterPanelAfterPinPopup() {
  releaseFilterPanelForMobile();
}

function centerPinPopupOnMobile(pinId) {
  if (!isMobileViewport() || !pinId) {
    return;
  }
  requestAnimationFrame(() => {
    const popupEl = document.querySelector(`.pin-popup[data-pin-id="${pinId}"]`);
    if (!popupEl) {
      return;
    }
    try {
      popupEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (_error) {
      popupEl.scrollIntoView({ block: 'center' });
    }
  });
}

function colorForCategorySlug(slug) {
  if (!slug) {
    return '#ffffff';
  }
  const category = getCategoryBySlug(slug);
  return category?.color || '#ffffff';
}

function computeOpacityFromTTL(ttlSeconds) {
  let ageFactor = 1;
  if (typeof ttlSeconds === 'number' && !Number.isNaN(ttlSeconds)) {
    if (ttlSeconds > 3600) {
      ageFactor = 1;
    } else {
      ageFactor = Math.max(0.2, ttlSeconds / 3600);
    }
  }
  const finalOpacity = baseStrokeOpacity * ageFactor;
  const finalFillOpacity = baseFillOpacity * ageFactor;
  return { strokeOpacity: finalOpacity, fillOpacity: finalFillOpacity };
}

function getCategoryBySlug(slug) {
  return categoriesData.find((group) => group.slug === slug);
}

function getDefaultCreationSelection() {
  const defaultSlug = categoriesData.find((group) => group.slug === 'community')?.slug || categoriesData[0]?.slug || '';
  const group = getCategoryBySlug(defaultSlug);
  const subcategory = group?.subcategories?.[0]?.slug || `${defaultSlug}.default`;
  return { categorySlug: defaultSlug, subcategorySlug: subcategory };
}

function generateLiveMapUserId() {
  if (window.crypto && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `live-map-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function getOrCreateLiveMapUserId() {
  try {
    const storedId = localStorage.getItem(LIVE_MAP_USER_ID_STORAGE_KEY);
    if (storedId) {
      return storedId;
    }
    const newId = generateLiveMapUserId();
    localStorage.setItem(LIVE_MAP_USER_ID_STORAGE_KEY, newId);
    return newId;
  } catch (error) {
    console.warn('Не удалось использовать localStorage для liveMapUserId', error);
    return generateLiveMapUserId();
  }
}

function getUserLocationIcon() {
  if (userLocationIcon) {
    return userLocationIcon;
  }
  userLocationIcon = L.divIcon({
    className: 'user-location-marker',
    html: '<div class="user-location-dot"></div><div class="user-location-pulse"></div>',
    iconSize: [32, 32],
    iconAnchor: [16, 16],
    popupAnchor: [0, -16],
  });
  return userLocationIcon;
}

function showUserLocationMarker(latitude, longitude) {
  if (!map) {
    return;
  }
  const icon = getUserLocationIcon();
  if (!window.userLocationMarker) {
    window.userLocationMarker = L.marker([latitude, longitude], {
      icon,
      interactive: false,
      zIndexOffset: 1000,
    }).addTo(map);
  } else {
    window.userLocationMarker.setLatLng([latitude, longitude]);
    window.userLocationMarker.setIcon(icon);
    if (!map.hasLayer(window.userLocationMarker)) {
      window.userLocationMarker.addTo(map);
    }
  }
}

function updateUserAccuracyCircle(latitude, longitude, accuracy) {
  if (!map) {
    return;
  }
  const radius = typeof accuracy === 'number' ? accuracy : 0;
  if (!window.userAccuracyCircle) {
    window.userAccuracyCircle = L.circle([latitude, longitude], {
      radius,
      color: '#4e73df',
      fillColor: '#4e73df',
      fillOpacity: 0.15,
      weight: 1,
      interactive: false,
      pane: 'userAccuracyCirclePane',
    }).addTo(map);
    return;
  }
  window.userAccuracyCircle.setLatLng([latitude, longitude]);
  if (typeof accuracy === 'number') {
    window.userAccuracyCircle.setRadius(radius);
  }
  if (!map.hasLayer(window.userAccuracyCircle)) {
    window.userAccuracyCircle.addTo(map);
  }
}

function removeUserAccuracyCircle() {
  const circle = window.userAccuracyCircle;
  if (!circle) {
    return;
  }
  if (map && map.hasLayer(circle)) {
    map.removeLayer(circle);
  }
  if (typeof circle.remove === 'function') {
    circle.remove();
  }
  window.userAccuracyCircle = null;
}

function setShowAllMode(forceMode) {
  const nextMode = forceMode || (areAllCategoriesActive() ? SHOW_ALL_MODES.OFF : SHOW_ALL_MODES.ALL);
  if (!Object.values(SHOW_ALL_MODES).includes(nextMode)) {
    return;
  }
  showAllMode = nextMode;
  if (showAllMode === SHOW_ALL_MODES.ALL) {
    activateAllCategories();
  } else {
    deactivateAllCategories();
  }
  updateFiltersUi();
}

function updateShowAllButtonAppearance() {
  if (!showAllBtn) {
    return;
  }
  const allActive = areAllCategoriesActive();
  const noneActive = activeCategorySlugs.size === 0;
  const isActive = allActive;
  showAllBtn.classList.toggle('show-all-btn--active', isActive);
  showAllBtn.classList.toggle('show-all-btn--off', noneActive);
  showAllBtn.setAttribute('aria-pressed', String(isActive));
  const icon = showAllBtn.querySelector('.show-all-btn__icon');
  if (icon) {
    icon.textContent = noneActive ? 'ВЫКЛ' : 'ВКЛ';
  }
}

function areAllCategoriesActive() {
  return activeCategorySlugs.size === allCategorySlugs.length;
}

function updateFiltersUi() {
  syncCategoryChipsWithActiveSet();
  updateShowAllButtonAppearance();
  applyCategoryFilters();
}

function syncCategoryChipsWithActiveSet() {
  if (!categoryChips.length) {
    return;
  }
  categoryChips.forEach((chip) => {
    const slug = chip.dataset.categorySlug;
    const isActive = slug ? activeCategorySlugs.has(slug) : false;
    chip.classList.toggle('is-active', isActive);
    chip.setAttribute('aria-pressed', String(isActive));
  });
}

function activateAllCategories() {
  activeCategorySlugs.clear();
  allCategorySlugs.forEach((slug) => activeCategorySlugs.add(slug));
}

function deactivateAllCategories() {
  activeCategorySlugs.clear();
}

function fetchPins() {
  return fetch('/api/pins')
    .then((response) => response.json())
    .then((pins) => {
      const popupState = captureOpenPinPopupState();
      reconcilePins(pins);
      applyCategoryFilters();
      focusSharedPinIfNeeded();
      updateCounters();
      restoreOpenPinPopupState(popupState);
    })
    .catch((error) => {
      console.error('Failed to load pins', error);
    });
}

function refreshMarkers() {
  if (refreshInFlightPromise) {
    return refreshInFlightPromise;
  }

  if (refreshBtn) {
    refreshBtn.disabled = true;
    refreshBtn.classList.add('refresh-btn--loading');
  }

  refreshInFlightPromise = fetchPins().finally(() => {
    if (refreshBtn) {
      refreshBtn.disabled = false;
      refreshBtn.classList.remove('refresh-btn--loading');
    }
    refreshInFlightPromise = null;
  });

  return refreshInFlightPromise;
}

function startAutoRefresh() {
  if (autoRefreshTimerId) {
    clearInterval(autoRefreshTimerId);
  }
  autoRefreshTimerId = setInterval(() => {
    refreshMarkers();
  }, AUTO_REFRESH_INTERVAL);
}

function clearMarkers() {
  activeMarkers.forEach(({ marker }) => marker.remove());
  activeMarkers.length = 0;
}

function getActiveMarkerEntry(pinId) {
  const normalizedPinId = Number(pinId);
  if (!normalizedPinId) {
    return null;
  }
  return activeMarkers.find(({ marker }) => Number(marker.pinId) === normalizedPinId) || null;
}

function updateMarkerFromPin(entry, pin) {
  const { marker } = entry;
  entry.pin = pin;
  marker.pinCategorySlug = pin.category_slug;
  marker.pinColor = pin.color;
  marker.pinData = pin;

  const { strokeOpacity, fillOpacity } = computeOpacityFromTTL(pin.ttl_seconds);
  marker.setStyle({
    color: pin.color,
    fillColor: pin.color,
    fillOpacity,
    opacity: strokeOpacity,
  });

  marker.setLatLng([pin.lat, pin.lng]);

  const tooltipText = pin.title || pin.nickname || 'Метка';
  if (typeof marker.setTooltipContent === 'function') {
    marker.setTooltipContent(tooltipText);
  }

  const isPopupOpen = typeof marker.isPopupOpen === 'function' ? marker.isPopupOpen() : false;
  if (!isPopupOpen) {
    marker.setPopupContent(createPopupContent(pin));
  }
}

function reconcilePins(nextPins) {
  const incomingPins = Array.isArray(nextPins) ? nextPins : [];
  const incomingById = new Map();

  incomingPins.forEach((rawPin) => {
    const slug = rawPin.category_slug || rawPin.category;
    const pin = {
      ...rawPin,
      category_slug: slug,
      color: colorForCategorySlug(slug),
    };
    incomingById.set(Number(pin.id), pin);
  });

  for (let index = activeMarkers.length - 1; index >= 0; index -= 1) {
    const entry = activeMarkers[index];
    if (!incomingById.has(Number(entry.marker.pinId))) {
      entry.marker.remove();
      activeMarkers.splice(index, 1);
    }
  }

  incomingPins.forEach((rawPin) => {
    const normalizedPin = incomingById.get(Number(rawPin.id));
    if (!normalizedPin) {
      return;
    }
    const existingEntry = getActiveMarkerEntry(normalizedPin.id);
    if (!existingEntry) {
      addPinToMap(normalizedPin);
      return;
    }
    updateMarkerFromPin(existingEntry, normalizedPin);
  });
}

function extractSharedPinTokenFromPath(pathname) {
  const rawPath = typeof pathname === 'string' ? pathname : window.location.pathname || '';
  if (!rawPath.toLowerCase().startsWith('/pin/')) {
    return null;
  }
  const tokenCandidate = rawPath.slice(5).split('/')[0];
  if (!tokenCandidate) {
    return null;
  }
  try {
    const decoded = decodeURIComponent(tokenCandidate.trim());
    return decoded || null;
  } catch (_error) {
    return tokenCandidate.trim() || null;
  }
}

function parseSharedPinTokenFromUrl() {
  pendingSharedPinToken = extractSharedPinTokenFromPath(window.location.pathname);
}

function focusSharedPinIfNeeded() {
  if (!pendingSharedPinToken || !map) {
    return;
  }
  const targetEntry = activeMarkers.find(({ pin }) => pin?.shared_token && pin.shared_token === pendingSharedPinToken);
  if (!targetEntry) {
    return;
  }
  const { marker } = targetEntry;
  const latlng = typeof marker.getLatLng === 'function' ? marker.getLatLng() : null;
  if (latlng) {
    map.setView(latlng, 15, { animate: true });
  }
  if (typeof marker.openPopup === 'function') {
    marker.openPopup();
  } else if (typeof marker.fire === 'function') {
    marker.fire('click');
  }
  pendingSharedPinToken = null;
}

function captureOpenPinPopupState() {
  const openedEntry = activeMarkers.find(({ marker }) => typeof marker.isPopupOpen === 'function' && marker.isPopupOpen());
  if (!openedEntry) {
    return null;
  }

  const pinId = Number(openedEntry.marker.pinId);
  if (!pinId) {
    return null;
  }

  const popupEl = document.querySelector(`.pin-popup[data-pin-id="${pinId}"]`);
  const inputEl = popupEl ? popupEl.querySelector('.pin-comments__form input[name="comment"]') : null;
  const listEl = popupEl ? popupEl.querySelector('.pin-comments__list') : null;

  return {
    pinId,
    inputValue: inputEl ? inputEl.value : '',
    selectionStart: inputEl && typeof inputEl.selectionStart === 'number' ? inputEl.selectionStart : null,
    selectionEnd: inputEl && typeof inputEl.selectionEnd === 'number' ? inputEl.selectionEnd : null,
    wasFocused: Boolean(inputEl && document.activeElement === inputEl),
    commentsScrollTop: listEl ? listEl.scrollTop : null,
  };
}

function restoreOpenPinPopupState(state) {
  if (!state || !state.pinId) {
    return;
  }

  const entry = getActiveMarkerEntry(state.pinId);
  if (!entry) {
    return;
  }

  const marker = entry.marker;
  if (typeof marker.isPopupOpen === 'function' && !marker.isPopupOpen()) {
    marker.openPopup();
  }

  requestAnimationFrame(() => {
    const popupEl = document.querySelector(`.pin-popup[data-pin-id="${state.pinId}"]`);
    if (!popupEl) {
      return;
    }

    const inputEl = popupEl.querySelector('.pin-comments__form input[name="comment"]');
    if (inputEl) {
      inputEl.value = state.inputValue || '';
      if (typeof state.selectionStart === 'number' && typeof state.selectionEnd === 'number') {
        try {
          inputEl.setSelectionRange(state.selectionStart, state.selectionEnd);
        } catch (_error) {
          // Ignore unsupported input state restoration.
        }
      }
      if (state.wasFocused) {
        try {
          inputEl.focus({ preventScroll: true });
        } catch (_error) {
          inputEl.focus();
        }
      }
    }

    const listEl = popupEl.querySelector('.pin-comments__list');
    if (listEl && typeof state.commentsScrollTop === 'number') {
      listEl.scrollTop = state.commentsScrollTop;
      updateScrollHintState(listEl);
    }
  });
}

function createPopupContent(pin) {
  const category = getCategoryBySlug(pin.category_slug);
  const currentNickname = currentAuthUser?.nickname || null;
  const isAuthor = Boolean(currentNickname && pin.user_id && currentNickname === pin.user_id);
  const deleteButton = isAuthor
    ? `<button class="delete-pin delete-pin-btn" data-pin-id="${pin.id}">Удалить</button>`
    : '';
  const shareUrl = new URL(`/pin/${pin.shared_token}`, window.location.origin).href;
  const commentsList = renderCommentsList(pin.comments || [], currentNickname, pin.id);
  const commentForm = renderCommentForm(currentNickname, pin.id);

  return `
    <div class="pin-popup" data-pin-id="${pin.id}">
      <strong>${pin.nickname}</strong>
      <p class="pin-popup__category">${category?.icon ?? ''} ${category?.label ?? 'Категория'}</p>
      <p>${pin.description}</p>
      <div class="pin-popup__meta">
        <span>Контакт: ${pin.contact || '—'}</span>
        <span>Рейтинг: ${pin.rating}</span>
      </div>
      <p class="pin-popup__ttl">Живёт ещё: ${pin.ttl_seconds ? Math.ceil(pin.ttl_seconds / 60) : '∞'} мин.</p>
      <div class="pin-popup__actions">
        <button type="button" class="popup-share${isAuthor ? '' : ' popup-share--single'}" data-share-url="${shareUrl}">Поделиться</button>
        ${deleteButton}
      </div>
      <div class="pin-comments" data-pin-id="${pin.id}">
        <div class="pin-comments__header">
          <span>Комментарии</span>
        </div>
        ${commentsList}
        ${commentForm}
      </div>
    </div>
  `;
}

function renderCommentsList(comments, currentNickname, pinId) {
  const hasComments = Array.isArray(comments) && comments.length > 0;
  if (!hasComments) {
    return '<div class="pin-comments__empty">Комментариев пока нет</div>';
  }
  const items = comments
    .map((comment) => {
      const canDelete = currentNickname && currentNickname === comment.user_id;
      return `
        <div class="pin-comment" data-comment-id="${comment.id}">
          <div class="pin-comment__text">
            <span class="pin-comment__author">${comment.user_id || 'Аноним'}:</span>
            <span class="pin-comment__body">${escapeHtml(comment.text)}</span>
          </div>
          <div class="pin-comment__meta">
            <span class="pin-comment__time">${formatTimestamp(comment.timestamp)}</span>
            ${canDelete ? `<button class="pin-comment__delete" data-pin-id="${pinId}" data-comment-id="${comment.id}" title="Удалить комментарий">✖</button>` : ''}
          </div>
        </div>
      `;
    })
    .join('');
  return `<div class="pin-comments__list" data-pin-id="${pinId}">${items}</div>`;
}

function getCommentsListElement(pinId) {
  const popup = document.querySelector(`.pin-popup[data-pin-id="${pinId}"]`);
  if (!popup) {
    return null;
  }
  return popup.querySelector('.pin-comments__list');
}

function getOrCreateCommentsList(pinId, snapshot) {
  const popup = document.querySelector(`.pin-popup[data-pin-id="${pinId}"]`);
  if (!popup) {
    return null;
  }
  let listEl = popup.querySelector('.pin-comments__list');
  if (listEl) {
    return listEl;
  }
  const currentNickname = currentAuthUser?.nickname || null;
  const markup = renderCommentsList(snapshot, currentNickname, pinId);
  const placeholder = popup.querySelector('.pin-comments__empty');
  if (placeholder) {
    placeholder.outerHTML = markup;
  } else {
    const wrapper = popup.querySelector('.pin-comments');
    if (wrapper) {
      wrapper.insertAdjacentHTML('beforeend', markup);
    }
  }
  return popup.querySelector('.pin-comments__list');
}

function ensureCommentScrollMeta(pinId) {
  if (!commentScrollState.has(pinId)) {
    commentScrollState.set(pinId, { locked: false });
  }
  return commentScrollState.get(pinId);
}

function updateScrollHintState(listEl) {
  if (!listEl) {
    return;
  }
  const hasOffset = listEl.scrollTop > 10;
  listEl.classList.toggle('pin-comments__list--scrollable', hasOffset);
}

function bindCommentListScroll(pinId, listEl) {
  if (!listEl || listEl.dataset.scrollBound === 'true') {
    return;
  }
  listEl.dataset.scrollBound = 'true';
  listEl.addEventListener(
    'scroll',
    () => {
      const meta = ensureCommentScrollMeta(pinId);
      const distanceFromBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight;
      meta.locked = distanceFromBottom > 40;
      updateScrollHintState(listEl);
    },
    { passive: true }
  );
}

function scrollCommentsToBottom(pinId, options = {}) {
  const { force = false, smooth = true } = options;
  const listEl = getCommentsListElement(pinId);
  if (!listEl) {
    return;
  }
  const meta = ensureCommentScrollMeta(pinId);
  if (!force && meta.locked) {
    return;
  }
  listEl.scrollTo({
    top: listEl.scrollHeight,
    behavior: smooth ? 'smooth' : 'auto',
  });
  meta.locked = false;
  requestAnimationFrame(() => updateScrollHintState(listEl));
}

function buildCommentElement(comment, pinId, canDelete) {
  const wrapper = document.createElement('div');
  wrapper.className = 'pin-comment';
  wrapper.dataset.commentId = comment.id;

  const textBlock = document.createElement('div');
  textBlock.className = 'pin-comment__text';
  const authorEl = document.createElement('span');
  authorEl.className = 'pin-comment__author';
  authorEl.textContent = `${comment.user_id || 'Аноним'}:`;
  const bodyEl = document.createElement('span');
  bodyEl.className = 'pin-comment__body';
  bodyEl.textContent = comment.text || '';
  textBlock.append(authorEl, bodyEl);

  const metaEl = document.createElement('div');
  metaEl.className = 'pin-comment__meta';
  const timeEl = document.createElement('span');
  timeEl.className = 'pin-comment__time';
  timeEl.textContent = formatTimestamp(comment.timestamp);
  metaEl.appendChild(timeEl);
  if (canDelete) {
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'pin-comment__delete';
    deleteBtn.dataset.pinId = String(pinId);
    deleteBtn.dataset.commentId = comment.id;
    deleteBtn.title = 'Удалить комментарий';
    deleteBtn.textContent = '✖';
    metaEl.appendChild(deleteBtn);
  }

  wrapper.append(textBlock, metaEl);
  return wrapper;
}

function applyCommentsUpdate(pinId, comments, options = {}) {
  const { animateNew = false, forceScroll = false } = options;
  const normalized = Array.isArray(comments) ? comments.slice() : [];
  const listEl = getOrCreateCommentsList(pinId, normalized);
  if (!listEl) {
    return;
  }

  const currentNickname = currentAuthUser?.nickname || null;
  const previous = commentStateCache.get(pinId) || [];
  const previousIds = new Set(previous.map((comment) => comment.id));
  const meta = ensureCommentScrollMeta(pinId);

  listEl.innerHTML = '';
  if (!normalized.length) {
    listEl.innerHTML = '<div class="pin-comments__empty">Комментариев пока нет</div>';
    commentStateCache.set(pinId, []);
    updateScrollHintState(listEl);
    return;
  }

  let hasNewEntries = false;
  normalized.forEach((comment) => {
    const canDelete = currentNickname && currentNickname === comment.user_id;
    const commentEl = buildCommentElement(comment, pinId, canDelete);
    const isNewEntry = !previousIds.has(comment.id);
    if (animateNew && isNewEntry) {
      commentEl.classList.add('pin-comment--incoming');
    }
    if (isNewEntry) {
      hasNewEntries = true;
    }
    listEl.appendChild(commentEl);
  });

  commentStateCache.set(pinId, normalized);
  bindCommentListScroll(pinId, listEl);
  updateScrollHintState(listEl);
  if (forceScroll) {
    scrollCommentsToBottom(pinId, { force: true, smooth: true });
  } else if (hasNewEntries && !meta.locked) {
    scrollCommentsToBottom(pinId, { force: true, smooth: animateNew });
  }
}

function initializeCommentsView(pinId, comments) {
  commentStateCache.set(pinId, Array.isArray(comments) ? comments.slice() : []);
  const listEl = getCommentsListElement(pinId);
  if (listEl) {
    bindCommentListScroll(pinId, listEl);
    requestAnimationFrame(() => {
      scrollCommentsToBottom(pinId, { force: true, smooth: false });
      updateScrollHintState(listEl);
    });
  }
}

function shouldUpdateComments(pinId, nextComments) {
  const cached = commentStateCache.get(pinId) || [];
  if (cached.length !== nextComments.length) {
    return true;
  }
  for (let i = 0; i < cached.length; i += 1) {
    if (cached[i]?.id !== nextComments[i]?.id) {
      return true;
    }
  }
  return false;
}

function isPopupStillOpen(pinId) {
  const popup = document.querySelector(`.pin-popup[data-pin-id="${pinId}"]`);
  return Boolean(popup && popup.offsetParent !== null);
}

function pollComments(pinId) {
  if (!pinId) {
    return Promise.resolve();
  }
  return fetch(`/get_comments?marker_id=${pinId}`, { credentials: 'same-origin' })
    .then(handleJsonResponse)
    .then((payload) => {
      const comments = payload?.comments || [];
      if (!isPopupStillOpen(pinId)) {
        stopCommentPolling(pinId);
        return;
      }
      if (!shouldUpdateComments(pinId, comments)) {
        return;
      }
      applyCommentsUpdate(pinId, comments, { animateNew: true });
    })
    .catch((error) => {
      console.error('Не удалось получить комментарии', error);
    });
}

function startCommentPolling(pinId) {
  if (!pinId) {
    return;
  }
  stopCommentPolling(pinId);
  pollComments(pinId);
  const timerId = setInterval(() => {
    pollComments(pinId);
  }, COMMENT_POLL_INTERVAL);
  commentPollers.set(pinId, timerId);
}

function stopCommentPolling(pinId) {
  const timerId = commentPollers.get(pinId);
  if (timerId) {
    clearInterval(timerId);
    commentPollers.delete(pinId);
  }
}

function renderCommentForm(currentNickname, pinId) {
  if (!currentNickname) {
    return '<div class="pin-comments__hint">Войдите, чтобы написать комментарий.</div>';
  }
  return `
    <form class="pin-comments__form" data-pin-id="${pinId}">
      <input type="text" name="comment" maxlength="${COMMENT_MAX_LENGTH}" placeholder="Написать..." autocomplete="off" />
      <button type="submit">Отправить</button>
    </form>
  `;
}

function escapeHtml(text = '') {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTimestamp(timestamp) {
  if (!timestamp) {
    return '';
  }
  try {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) {
      return '';
    }
    return date.toLocaleString('ru-RU', {
      dateStyle: 'short',
      timeStyle: 'short',
    });
  } catch (_error) {
    return '';
  }
}

function applyPopupFadeEffect(popup) {
  if (!popup || typeof popup.getElement !== 'function') {
    return;
  }
  const container = popup.getElement();
  if (!container) {
    return;
  }
  const wrapper = container.querySelector('.leaflet-popup-content-wrapper');
  if (!wrapper) {
    return;
  }
  wrapper.classList.remove('popup-fade-in');
  // Force reflow to restart animation
  void wrapper.offsetWidth;
  wrapper.classList.add('popup-fade-in');
}

function getCreationPopupContent(latlng) {
  const categoryButtons = categoriesData
    .map((group) => {
      const isSelected = creationSelection.categorySlug === group.slug;
      return `
        <button type="button" class="creation-popup__category ${isSelected ? 'is-selected' : ''}" data-category-slug="${group.slug}" style="--popup-chip-color: ${group.color};">
          <span class="creation-popup__category-icon">${group.icon}</span>
          <span class="creation-popup__category-label">${group.label}</span>
        </button>
      `;
    })
    .join('');

  return `
    <div class="creation-popup">
      <strong>Новая метка</strong>
      <p class="creation-popup__coords">Координаты: ${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}</p>
      <div class="creation-popup__category-row" data-selected-category="${creationSelection.categorySlug}">
        ${categoryButtons}
      </div>
      <label>
        Название
        <input data-field="nickname" type="text" placeholder="Название" />
      </label>
      <label>
        Описание
        <textarea data-field="description" rows="3" placeholder="Краткое описание"></textarea>
      </label>
      <label>
        Контакт
        <input data-field="contact" type="text" placeholder="Телефон или мессенджер" />
      </label>
      <button type="button" class="creation-popup__save">Сохранить метку</button>
    </div>
  `;
}

function placeCreationMarker(latlng) {
  clearCreationMarker();

  creationSelection = getDefaultCreationSelection();
  const tempColor = colorForCategorySlug(creationSelection.categorySlug);
  const { strokeOpacity, fillOpacity } = computeOpacityFromTTL(Number.POSITIVE_INFINITY);
  const marker = L.circleMarker(latlng, {
    color: tempColor,
    fillColor: tempColor,
    fillOpacity,
    weight: 3,
    opacity: strokeOpacity,
    radius: 12,
  });
  marker.isCreationMarker = true;
  window.currentCreationMarker = marker;
  marker.addTo(map);
  marker.bindPopup(getCreationPopupContent(latlng), {
    closeOnClick: false,
    autoPan: true,
    keepInView: true,
    autoPanPaddingTopLeft: L.point(12, 12),
    autoPanPaddingBottomRight: L.point(12, 12),
  });
  marker.on('popupopen', (event) => {
    applyPopupFadeEffect(event.popup);
    minimizeFilterPanelForCreation();
  });
  marker.on('popupclose', () => {
    clearCreationMarker();
    restoreFilterPanelAfterCreation();
  });
  marker.openPopup();
  return marker;
}

function clearCreationMarker() {
  const markerToRemove = window.currentCreationMarker;
  if (!markerToRemove) {
    return;
  }
  window.currentCreationMarker = null;
  map.closePopup();
  if (map && map.hasLayer(markerToRemove)) {
    map.removeLayer(markerToRemove);
  }
  if (typeof markerToRemove.remove === 'function') {
    markerToRemove.remove();
  }
}

function countCurrentUserMarkers() {
  const currentNickname = currentAuthUser?.nickname || null;
  if (!currentNickname) {
    return 0;
  }
  return activeMarkers.reduce((count, { pin }) => (pin.user_id === currentNickname ? count + 1 : count), 0);
}

function hasReachedUserMarkerLimit() {
  return countCurrentUserMarkers() >= USER_MARKER_LIMIT;
}

function showUserToast(message) {
  let toast = document.getElementById('user-toast-notification');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'user-toast-notification';
    toast.className = 'user-toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('user-toast--visible');
  if (userToastTimeoutId) {
    clearTimeout(userToastTimeoutId);
  }
  userToastTimeoutId = setTimeout(() => {
    toast.classList.remove('user-toast--visible');
  }, 3800);
}

function getAuthElements() {
  return {
    statusEl: document.getElementById('auth-status'),
    messageEl: document.getElementById('auth-message'),
    authForm: document.getElementById('auth-form'),
    authSubmitBtn: document.getElementById('auth-submit-btn'),
    authTitle: document.getElementById('auth-panel-title'),
    switchText: document.getElementById('auth-switch-text'),
    switchPrefix: document.getElementById('auth-switch-prefix'),
    switchLink: document.getElementById('auth-switch-link'),
    logoutBtn: document.getElementById('logout-btn'),
    panelEl: document.getElementById('auth-panel'),
    toggleBtn: document.getElementById('auth-toggle-btn'),
  };
}

function setAuthMessage(text = '') {
  const { messageEl } = getAuthElements();
  if (!messageEl) {
    return;
  }
  const normalized = typeof text === 'string' ? text.trim() : '';
  messageEl.textContent = normalized;
  messageEl.hidden = normalized.length === 0;
}

function clearAuthMessage() {
  setAuthMessage('');
}

function setAuthPanelVisibility(visible) {
  const wasVisible = authPanelVisible;
  authPanelVisible = Boolean(visible);
  if (authPanelElement) {
    authPanelElement.hidden = !authPanelVisible;
    authPanelElement.classList.toggle('is-visible', authPanelVisible);
  }
  if (authToggleBtn) {
    authToggleBtn.classList.toggle('panel-round-btn--active', authPanelVisible);
    authToggleBtn.setAttribute('aria-pressed', String(authPanelVisible));
  }
  toggleUserPanelExpandedState(authPanelVisible);
  if (authPanelVisible && !wasVisible) {
    clearAuthMessage();
  }
}

function toggleUserPanelExpandedState(expanded) {
  const panel = document.querySelector('.user-panel');
  const filterShell = getFilterPanelElement();
  const content = panel?.querySelector('.user-panel__content');
  panel?.setAttribute('aria-expanded', String(Boolean(expanded)));
  filterShell?.classList.toggle('filter-panel--user-expanded', expanded);
  content?.classList.toggle('is-visible', expanded);
  const chips = filterShell?.querySelector('.category-chips');
  chips?.classList.toggle('is-hidden', expanded);
  if (expanded) {
    chips?.setAttribute('aria-hidden', 'true');
    panel?.setAttribute('data-panel-visible', 'profile');
  } else {
    chips?.removeAttribute('aria-hidden');
    panel?.removeAttribute('data-panel-visible');
  }
}

function syncAuthToggleAppearance() {
  if (!authToggleBtn) {
    return;
  }
  const label = authToggleBtn.querySelector('.panel-round-btn__label');
  if (isAuthenticated()) {
    authToggleBtn.classList.add('panel-round-btn--auth');
    authToggleBtn.setAttribute('aria-label', 'Открыть панель аккаунта');
    if (label) {
      label.textContent = '👤';
    }
  } else {
    authToggleBtn.classList.remove('panel-round-btn--auth');
    authToggleBtn.setAttribute('aria-label', 'Открыть панель входа');
    if (label) {
      label.textContent = 'ВХОД';
    }
  }
}

function setAuthToggleAvatar(url) {
  const button = document.getElementById('auth-toggle-btn');
  const avatarImg = button?.querySelector('.panel-round-btn__avatar img');
  if (!button || !avatarImg) {
    return;
  }
  if (url) {
    avatarImg.src = url;
    button.classList.add('panel-round-btn--has-avatar');
  } else {
    avatarImg.removeAttribute('src');
    button.classList.remove('panel-round-btn--has-avatar');
  }
}

function isAuthenticated() {
  return Boolean(currentAuthUser && currentAuthUser.nickname);
}


function updateAuthModeUI() {
  const { authTitle, authSubmitBtn, switchPrefix, switchLink } = getAuthElements();
  if (!authTitle || !authSubmitBtn || !switchPrefix || !switchLink) {
    return;
  }
  const isLogin = currentAuthMode === AUTH_MODES.LOGIN;
  authTitle.textContent = isLogin ? 'Войдите в аккаунт' : 'Создайте аккаунт';
  authSubmitBtn.textContent = isLogin ? 'Войти' : 'Регистрация';
  switchPrefix.textContent = isLogin ? 'Или' : 'Уже есть аккаунт?';
  switchLink.textContent = isLogin ? 'создайте аккаунт' : 'Войти';
  syncAuthModeFields();
  syncPasswordAutocomplete();
}

function toggleAuthMode() {
  currentAuthMode = currentAuthMode === AUTH_MODES.LOGIN ? AUTH_MODES.REGISTER : AUTH_MODES.LOGIN;
  updateAuthModeUI();
  clearAuthMessage();
}

function syncAuthModeFields() {
  const isRegisterMode = currentAuthMode === AUTH_MODES.REGISTER;
  document.querySelectorAll('[data-auth-mode="register"]').forEach((field) => {
    const input = field.querySelector('input');
    field.hidden = !isRegisterMode;
    field.classList.toggle('auth-field--hidden', !isRegisterMode);
    field.setAttribute('aria-hidden', String(!isRegisterMode));
    if (input) {
      if (isRegisterMode) {
        input.disabled = false;
        input.required = true;
        input.removeAttribute('disabled');
        input.setAttribute('aria-disabled', 'false');
      } else {
        input.disabled = true;
        input.required = false;
        input.setAttribute('aria-disabled', 'true');
        input.value = '';
      }
    }
  });
}

function syncPasswordAutocomplete() {
  const { authForm } = getAuthElements();
  if (!authForm || !authForm.elements) {
    return;
  }
  const passwordInput = authForm.elements.password;
  const confirmInput = authForm.elements.password_confirm;
  if (passwordInput) {
    const isLogin = currentAuthMode === AUTH_MODES.LOGIN;
    const autocompleteValue = isLogin ? 'current-password' : 'new-password';
    passwordInput.setAttribute('autocomplete', autocompleteValue);
  }
  if (confirmInput) {
    confirmInput.setAttribute('autocomplete', 'off');
  }
}

function emitProfileAuthEvent(detail = {}) {
  try {
    document.dispatchEvent(new CustomEvent('profile:auth-state-changed', { detail }));
  } catch (error) {
    console.warn('Не удалось отправить событие профиля', error);
  }
}

function renderAuthState(message = '') {
  const { statusEl, authForm, logoutBtn, switchLink, switchText, authTitle, messageEl, panelEl } = getAuthElements();
  const authenticated = isAuthenticated();
  const nickname = currentAuthUser?.nickname || '';
  const displayNameInput = document.querySelector('.user-panel__input[name="profile_display_name"]');
  const userPanelEl = document.querySelector('.user-panel');
  if (displayNameInput) {
    displayNameInput.value = nickname;
    displayNameInput.disabled = !authenticated;
  }
  if (statusEl) {
    statusEl.textContent = authenticated ? nickname : 'Не авторизован';
  }
  if (panelEl) {
    panelEl.classList.toggle('auth-panel--authenticated', authenticated);
  }
  if (userPanelEl) {
    userPanelEl.classList.toggle('user-panel--guest', !authenticated);
  }
  if (authForm) {
    authForm.hidden = authenticated;
  }
  if (logoutBtn) {
    logoutBtn.hidden = !authenticated;
  }
  if (switchLink) {
    switchLink.hidden = authenticated;
  }
  if (switchText) {
    switchText.hidden = authenticated;
  }
  if (authTitle) {
    authTitle.hidden = authenticated;
  }
  if (!authenticated) {
    setAuthMessage(message);
    if (messageEl) {
      messageEl.hidden = message.trim().length === 0;
    }
  } else {
    clearAuthMessage();
    if (messageEl) {
      messageEl.hidden = true;
    }
  }
  syncAuthToggleAppearance();
  setAuthToggleAvatar(authenticated ? currentAuthUser?.avatar_url : null);
  emitProfileAuthEvent({ authenticated, user: currentAuthUser, message });
}

function initProfileSettings() {
  const profileSection = document.querySelector('.user-panel');
  const profileForm = document.getElementById('profile-form');
  const passwordForm = document.getElementById('password-form');
  const avatarInput = document.getElementById('profile-avatar-input');
  const avatarPreview = document.querySelector('.profile-avatar__image');
  const avatarPlaceholder = avatarPreview?.querySelector('.profile-avatar__placeholder');
  const avatarImg = avatarPreview?.querySelector('img');
  const avatarUploadBtn = document.querySelector('[data-profile-action="upload-avatar"]');
  const editToggleBtn = document.querySelector('[data-profile-action="toggle-edit"]');
  const cancelBtn = document.querySelector('[data-profile-action="cancel"]');
  const saveBtn = document.querySelector('[data-profile-action="save"]');
  const passwordToggleBtn = document.querySelector('[data-password-action="toggle"]');
  const passwordCancelBtn = document.querySelector('[data-password-action="cancel"]');
  const passwordSaveBtn = document.querySelector('[data-password-action="save"]');
  const profileView = profileSection?.querySelector('[data-profile-view]');
  const profileViewNicknameEl = document.getElementById('profile-view-nickname');
  const profileViewAgeEl = document.getElementById('profile-view-age');
  const profileViewGenderEl = document.getElementById('profile-view-gender');
  if (!profileSection || !profileForm) {
    return;
  }

  const formFields = {
    displayName: profileForm.querySelector('[data-profile-field="display-name"]'),
    age: profileForm.querySelector('[data-profile-field="age"]'),
    gender: profileForm.querySelector('[data-profile-field="gender"]'),
  };

  let profileSnapshot = {};
  let profileMode = 'view';
  let passwordState = 'collapsed';

   const formatProfileAge = (value) => {
     if (value === null || value === undefined || value === '') {
       return '—';
     }
     return String(value);
   };

   const formatProfileGender = (value) => PROFILE_GENDER_LABELS[value] || '—';

   const updateProfileViewState = () => {
     if (profileView) {
       profileView.setAttribute('aria-hidden', String(profileMode === 'edit'));
     }
     if (profileViewNicknameEl) {
       profileViewNicknameEl.textContent = profileSnapshot.nickname || 'Гость';
     }
     if (profileViewAgeEl) {
       profileViewAgeEl.textContent = formatProfileAge(profileSnapshot.age);
     }
     if (profileViewGenderEl) {
       profileViewGenderEl.textContent = formatProfileGender(profileSnapshot.gender);
     }
   };

   const syncProfileSnapshot = () => {
    profileSnapshot = {
      nickname: currentAuthUser?.nickname || '',
      age: currentAuthUser?.age ?? '',
      gender: currentAuthUser?.gender ?? '',
      avatarUrl: currentAuthUser?.avatar_url || null,
    };
    if (formFields.displayName) {
      formFields.displayName.value = profileSnapshot.nickname;
    }
    if (formFields.age) {
      formFields.age.value = profileSnapshot.age ?? '';
    }
    if (formFields.gender) {
      formFields.gender.value = profileSnapshot.gender ?? '';
    }
     renderAvatar(profileSnapshot.avatarUrl);
     updateProfileViewState();
     reflectProfileState();
  };

  const renderAvatar = (url) => {
    if (!avatarPreview) {
      return;
    }
    if (url && avatarImg) {
      avatarImg.src = url;
      avatarImg.hidden = false;
      avatarPlaceholder?.setAttribute('hidden', 'true');
    } else if (avatarImg) {
      avatarImg.hidden = true;
      avatarPlaceholder?.removeAttribute('hidden');
    }
  };

  const reflectProfileState = () => {
     profileSection.dataset.profileMode = profileMode;
    const isEdit = profileMode === 'edit';
     const isView = !isEdit;
    editToggleBtn?.setAttribute('aria-pressed', String(isEdit));
    if (editToggleBtn) {
      editToggleBtn.innerHTML = isEdit ? 'Вернуться к просмотру' : 'Редактировать профиль';
    }
    if (saveBtn) {
      saveBtn.disabled = !isEdit;
      saveBtn.setAttribute('aria-disabled', String(!isEdit));
    }
    if (cancelBtn) {
      cancelBtn.disabled = !isEdit;
      cancelBtn.setAttribute('aria-disabled', String(!isEdit));
    }
    profileSection.classList.toggle('user-panel--editing', isEdit);

     const collapse = document.querySelector('.password-collapse');
    if (collapse) {
      collapse.dataset.passwordState = passwordState;
      const expanded = passwordState === 'expanded';
      if (passwordForm) {
        passwordForm.hidden = !expanded;
        if (!expanded) {
          passwordForm.reset();
        }
      }
      passwordToggleBtn?.setAttribute('aria-expanded', String(expanded));
      passwordToggleBtn?.setAttribute('aria-pressed', String(expanded));
    }
  };

  const setProfileMode = (mode) => {
    profileMode = mode;
    const isEdit = mode === 'edit';
    reflectProfileState();
    if (!isEdit) {
      syncProfileSnapshot();
      setPasswordState('collapsed');
    }
  };

  resetProfileToViewMode = () => setProfileMode('view');

  const setPasswordState = (state) => {
    passwordState = state;
    reflectProfileState();
  };

  const showToastMessage = (message) => {
    if (!message) {
      return;
    }
    showUserToast(message);
  };

  const updateUserState = (payload, message) => {
    if (!payload) {
      return;
    }
    const userData = payload.user || payload;
    currentAuthUser = userData;
    renderAuthState(message || 'Профиль обновлён.');
    setAuthToggleAvatar(userData?.avatar_url || null);
    document.dispatchEvent(new CustomEvent('profile:user-updated', { detail: { user: userData } }));
    refreshMarkers();
  };

    const submitProfileForm = () => {
      if (!isAuthenticated()) {
        showToastMessage('Нужно войти в аккаунт.');
        return;
      }
      const nicknameInputValue = formFields.displayName?.value?.trim() || currentAuthUser?.nickname || '';
      const payload = {
        nickname: nicknameInputValue,
        age: formFields.age?.value ?? null,
        gender: formFields.gender?.value ?? null,
      };
      fetch('/profile', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'same-origin',
        body: JSON.stringify(payload),
      })
        .then(handleJsonResponse)
        .then((response) => {
          updateUserState(response, 'Профиль обновлён.');
          setProfileMode('view');
        })
        .catch((error) => {
          showToastMessage(error.message || 'Не удалось сохранить профиль.');
        });
    };

    const submitPasswordForm = () => {
      if (!passwordForm) {
        return;
      }
      const formData = new FormData(passwordForm);
      const currentPassword = formData.get('current_password');
      const newPassword = formData.get('new_password');
      const newPasswordConfirm = formData.get('new_password_confirm');
      if (!currentPassword || !newPassword || !newPasswordConfirm) {
        showToastMessage('Все поля пароля должны быть заполнены.');
        return;
      }
      if (newPassword.length < 6) {
        showToastMessage('Пароль должен быть не короче 6 символов.');
        return;
      }
      if (newPassword !== newPasswordConfirm) {
        showToastMessage('Новый пароль и его подтверждение не совпадают.');
        return;
      }
      fetch('/profile/password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'same-origin',
        body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
      })
        .then(handleJsonResponse)
        .then(() => {
          showToastMessage('Пароль обновлён.');
          passwordForm.reset();
          setPasswordState('collapsed');
        })
        .catch((error) => {
          showToastMessage(error.message || 'Не удалось обновить пароль.');
        });
    };

  const uploadAvatar = (file) => {
    if (!file || !isAuthenticated()) {
      return;
    }
    const formData = new FormData();
    formData.append('avatar', file);
    fetch('/profile/avatar', {
      method: 'POST',
      credentials: 'same-origin',
      body: formData,
    })
      .then(handleJsonResponse)
      .then((payload) => {
        updateUserState(payload, 'Аватар обновлён.');
      })
      .catch((error) => {
        showToastMessage(error.message || 'Не удалось загрузить аватар.');
      })
      .finally(() => {
        if (avatarInput) {
          avatarInput.value = '';
        }
      });
  };

  editToggleBtn?.addEventListener('click', () => {
    const isEdit = profileSection.dataset.profileMode === 'edit';
    setProfileMode(isEdit ? 'view' : 'edit');
  });

  profileForm.addEventListener('submit', (event) => {
    event.preventDefault();
    submitProfileForm();
  });

  cancelBtn?.addEventListener('click', () => {
    setProfileMode('view');
  });

  passwordToggleBtn?.addEventListener('click', () => {
      const currentState = document.querySelector('.password-collapse')?.dataset.passwordState || 'collapsed';
      setPasswordState(currentState === 'collapsed' ? 'expanded' : 'collapsed');
    });

  passwordCancelBtn?.addEventListener('click', () => {
    passwordForm?.reset();
    setPasswordState('collapsed');
  });

  passwordForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    submitPasswordForm();
  });

  avatarUploadBtn?.addEventListener('click', () => {
    avatarInput?.click();
  });

  avatarInput?.addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (file) {
      uploadAvatar(file);
    }
  });

  document.addEventListener('profile:auth-state-changed', (event) => {
    const { authenticated, user } = event.detail || {};
    if (!authenticated) {
      setProfileMode('view');
      setPasswordState('collapsed');
    }
    currentAuthUser = user || null;
    syncProfileSnapshot();
  });

  syncProfileSnapshot();
  setProfileMode('view');
}

function readAuthPayload(form) {
  const nickname = form?.elements?.nickname?.value?.trim() || '';
  const password = form?.elements?.password?.value || '';
  const confirmElement = form?.elements?.password_confirm;
  const passwordConfirm = confirmElement && !confirmElement.disabled ? confirmElement.value : '';
  return { nickname, password, passwordConfirm };
}

function handleAuthResponse(response) {
  return response
    .text()
    .then((rawBody) => {
      let payload = {};
      if (rawBody) {
        try {
          payload = JSON.parse(rawBody);
        } catch (_error) {
          payload = { message: rawBody };
        }
      }

      if (!response.ok) {
        const fallbackByStatus = {
          400: 'Проверьте корректность имени пользователя и пароля.',
          401: 'Неверные имя пользователя или пароль.',
          409: 'Пользователь с таким именем уже существует.',
          500: 'Временная ошибка сервера. Попробуйте позже.',
        };
        const fallback = fallbackByStatus[response.status] || `Ошибка авторизации (HTTP ${response.status}).`;
        throw new Error(payload?.message || fallback);
      }
      return payload;
    });
}

function submitAuth(endpoint, payload) {
  return fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'same-origin',
    body: JSON.stringify(payload),
  }).then(handleAuthResponse);
}

function refreshCurrentUser() {
  return fetch('/me', { credentials: 'same-origin' })
    .then((response) => response.json())
    .then((payload) => {
      currentAuthUser = payload?.authenticated ? payload.user : null;
      renderAuthState();
    })
    .catch(() => {
      currentAuthUser = null;
      renderAuthState();
    });
}

function initAuthWidget() {
  const { authForm, authSubmitBtn, logoutBtn, panelEl, toggleBtn, switchLink } = getAuthElements();
  authPanelElement = panelEl || null;
  authToggleBtn = toggleBtn || null;
  renderAuthState();
  updateAuthModeUI();
  setAuthPanelVisibility(false);
  initProfileSettings();

  if (authToggleBtn) {
    authToggleBtn.addEventListener('click', () => {
      ensureProfileViewMode();
      if (!authPanelVisible && getFilterPanelElement()?.classList.contains('collapsed')) {
        expandFilterPanel();
        setAuthPanelVisibility(true);
        return;
      }
      setAuthPanelVisibility(!authPanelVisible);
    });
  }

  if (switchLink) {
    switchLink.addEventListener('click', () => {
      toggleAuthMode();
    });
  }

  if (authForm) {
    authForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const { nickname, password, passwordConfirm } = readAuthPayload(authForm);
      const shouldValidateConfirm = currentAuthMode === AUTH_MODES.REGISTER;
      const confirmFieldActive = Boolean(authForm.elements.password_confirm && !authForm.elements.password_confirm.disabled);
      if (shouldValidateConfirm && confirmFieldActive && password !== passwordConfirm) {
        setAuthMessage('Пароли не совпадают');
        if (authSubmitBtn) {
          authSubmitBtn.disabled = false;
        }
        return;
      }
      clearAuthMessage();
      const payload = { nickname, password };
      const endpoint = currentAuthMode === AUTH_MODES.LOGIN ? '/login' : '/register';
      const successMessage = currentAuthMode === AUTH_MODES.LOGIN
        ? 'Вход выполнен.'
        : 'Регистрация завершена, вход выполнен.';
      if (authSubmitBtn) {
        authSubmitBtn.disabled = true;
      }
      submitAuth(endpoint, payload)
        .then((result) => {
          currentAuthUser = result.user;
          renderAuthState(successMessage);
          setAuthPanelVisibility(false);
          const displayNameInput = document.querySelector('.user-panel__input[name="profile_display_name"]');
          if (displayNameInput && currentAuthUser?.nickname) {
            displayNameInput.value = currentAuthUser.nickname;
          }
          refreshMarkers();
        })
        .catch((error) => {
          renderAuthState(error.message);
        })
        .finally(() => {
          if (authSubmitBtn) {
            authSubmitBtn.disabled = false;
          }
        });
    });
  }

  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      fetch('/logout', {
        method: 'POST',
        credentials: 'same-origin',
      })
        .then(() => {
          currentAuthUser = null;
          renderAuthState('Вы вышли из аккаунта.');
          setAuthPanelVisibility(false);
          refreshMarkers();
        })
        .catch(() => {
          renderAuthState('Не удалось выполнить выход.');
        });
    });
  }

  refreshCurrentUser();
}

function copyTextToClipboard(text) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    return navigator.clipboard.writeText(text);
  }
  return new Promise((resolve, reject) => {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'absolute';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      if (document.execCommand('copy')) {
        resolve();
      } else {
        reject(new Error('Не удалось скопировать ссылку.'));
      }
    } catch (error) {
      reject(error);
    } finally {
      document.body.removeChild(textarea);
    }
  });
}

async function shareLinkWithSystem(shareUrl) {
  const shareText = `Посмотри эту метку на карте: ${shareUrl}`;
  if (navigator.share) {
    try {
      await navigator.share({ title: 'Живая карта интересов', text: shareText, url: shareUrl });
      return;
    } catch (error) {
      if (error && error.name === 'AbortError') {
        return;
      }
      console.error('Не удалось открыть системное окно шаринга', error);
    }
  }
  try {
    await copyTextToClipboard(shareUrl);
    showUserToast('Ссылка скопирована!');
  } catch (copyError) {
    console.error('Не удалось скопировать ссылку:', copyError);
  }
}

function handleCreationSubmit(latlng, popupEl, saveBtn) {
  const form = popupEl;
  if (!form) {
    return;
  }
  if (!isAuthenticated()) {
    showUserToast('Нужно войти в аккаунт, чтобы создавать метки.');
    return;
  }
  const nickname = form.querySelector('[data-field="nickname"]').value.trim();
  const description = form.querySelector('[data-field="description"]').value.trim();
  const contact = form.querySelector('[data-field="contact"]').value.trim();
  if (!nickname || !description) {
    alert('Заполните название и описание.');
    return;
  }

  const payload = {
    category: creationSelection.categorySlug,
    category_slug: creationSelection.categorySlug,
    subcategory_slug: creationSelection.subcategorySlug,
    nickname,
    description,
    contact: contact || null,
    lat: latlng.lat,
    lng: latlng.lng,
  };
  saveBtn.disabled = true;
  fetch('/api/pins', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'same-origin',
    body: JSON.stringify(payload),
  })
    .then((response) => {
      if (!response.ok) {
        return response
          .json()
          .catch(() => ({}))
          .then((payload) => {
            const errorMessage = payload?.message || 'Не удалось сохранить метку.';
            throw new Error(errorMessage);
          });
      }
      return response.json();
    })
    .then((pin) => {
      addPinToMap(pin);
      map.closePopup();
      fetchPins();
    })
    .catch((error) => {
      if (error.message === USER_LIMIT_MESSAGE) {
        showUserToast(USER_LIMIT_MESSAGE);
      } else {
        alert(error.message);
      }
    })
    .finally(() => {
      saveBtn.disabled = false;
    });
}

function addPinToMap(pin) {
  const { strokeOpacity, fillOpacity } = computeOpacityFromTTL(pin.ttl_seconds);
  const marker = L.circleMarker([pin.lat, pin.lng], {
    color: pin.color,
    fillColor: pin.color,
    fillOpacity,
    weight: 3,
    opacity: strokeOpacity,
    radius: 12,
    interactive: true,
  });
  marker.pinId = pin.id;
  marker.pinCategorySlug = pin.category_slug;
  marker.pinColor = pin.color;
  marker.pinData = pin;
  const tooltipText = pin.title || pin.nickname || 'Метка';
  marker.bindTooltip(tooltipText, { sticky: true });
  if (isTouchDevice) {
    let tooltipVisible = false;
    marker.on('click', (event) => {
      L.DomEvent.stopPropagation(event);
      if (!tooltipVisible) {
        marker.openTooltip();
        tooltipVisible = true;
      } else {
        marker.openPopup();
        tooltipVisible = false;
      }
    });
    marker.on('popupopen', () => {
      tooltipVisible = false;
    });
  }
  marker.bindPopup(createPopupContent(pin));
  marker.on('popupopen', () => {
    attachCommentHandlers(marker.pinId);
    initializeCommentsView(marker.pinId, marker.pinData?.comments || []);
    startCommentPolling(marker.pinId);
    minimizeFilterPanelForPinPopup();
    centerPinPopupOnMobile(marker.pinId);
  });
  marker.on('popupclose', () => {
    stopCommentPolling(marker.pinId);
    restoreFilterPanelAfterPinPopup();
  });
  marker.on('popupopen', (event) => applyPopupFadeEffect(event.popup));
  if (activeCategorySlugs.has(pin.category_slug)) {
    marker.addTo(map);
  }
  activeMarkers.push({ marker, pin });
  updateCounters();
}

function updateCounters() {
  const counts = {};
  activeMarkers.forEach(({ pin }) => {
    counts[pin.category_slug] = (counts[pin.category_slug] || 0) + 1;
  });
  document.querySelectorAll('.category-chip').forEach((chip) => {
    const slug = chip.dataset.categorySlug;
    const counter = chip.querySelector('.category-count');
    if (counter) {
      counter.textContent = counts[slug] || '0';
    }
  });
}

function handleDeletePin(pinId) {
  if (!isAuthenticated()) {
    showUserToast('Нужно войти в аккаунт, чтобы удалять метки.');
    return;
  }

  fetch(`/api/pins/${pinId}`, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'same-origin',
    body: JSON.stringify({}),
  })
    .then((response) => {
      if (!response.ok) {
        throw new Error('Не удалось удалить метку.');
      }
      removePinFromMap(pinId);
      map.closePopup();
    })
    .catch((error) => {
      alert(error.message);
    });
}

function findUserLocation() {
  if (!navigator.geolocation) {
    alert('Геолокация недоступна в вашем браузере.');
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (position) => {
      const { latitude, longitude, accuracy } = position.coords;
      showUserLocationMarker(latitude, longitude);
      updateUserAccuracyCircle(latitude, longitude, accuracy);
      map.setView([latitude, longitude], 16, { animate: true });
    },
    (error) => {
      console.error('Ошибка GPS:', error);
      alert(`Ошибка: ${error.message} (Код: ${error.code})`);
      removeUserAccuracyCircle();
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

function removePinFromMap(pinId) {
  const index = activeMarkers.findIndex(({ marker }) => marker.pinId === pinId);
  if (index !== -1) {
    const { marker } = activeMarkers[index];
    marker.remove();
    activeMarkers.splice(index, 1);
  }
}

function applyCategoryFilters() {
  activeMarkers.forEach(({ marker, pin }) => {
    const shouldShow = activeCategorySlugs.has(pin.category_slug);
    const isOnMap = map.hasLayer(marker);
    if (shouldShow && !isOnMap) {
      marker.addTo(map);
    } else if (!shouldShow && isOnMap) {
      marker.remove();
    }
  });
}

function isAnyExistingPinPopupOpen() {
  return activeMarkers.some(({ marker }) => {
    const popup = marker.getPopup();
    return popup && map.hasLayer(popup);
  });
}

window.addEventListener('load', function () {
  initAuthWidget();
  parseSharedPinTokenFromUrl();

  map = L.map('leaflet-map', {
    zoomControl: true,
    attributionControl: false,
  }).setView([defaults.lat, defaults.lng], defaults.zoom);

  map.on('popupopen', (event) => applyPopupFadeEffect(event.popup));
  map.on('popupclose', (event) => {
    const sourceMarker = event?.popup?._source;
    const isCreationPopup = Boolean(sourceMarker && sourceMarker.isCreationMarker);
    if (!isCreationPopup) {
      lastNonCreationPopupCloseAt = Date.now();
    }
  });

  map.createPane('userAccuracyCirclePane');
  const userAccuracyCirclePane = map.getPane('userAccuracyCirclePane');
  if (userAccuracyCirclePane) {
    userAccuracyCirclePane.style.zIndex = '450';
    userAccuracyCirclePane.style.pointerEvents = 'none';
  }

  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© Участники OpenStreetMap',
    maxZoom: 19,
  }).addTo(map);
  setTimeout(() => {
    map.invalidateSize();
  }, 100);

  const geolocateBtn = L.DomUtil.create('a', 'leaflet-control-zoom-geolocate');
  geolocateBtn.innerHTML = '➤';
  geolocateBtn.href = '#';
  geolocateBtn.title = 'Центровать на мне';
  L.DomEvent.on(geolocateBtn, 'click', L.DomEvent.stopPropagation);
  geolocateBtn.addEventListener('click', (event) => {
    event.preventDefault();
    findUserLocation();
  });
  const zoomContainer = map.zoomControl.getContainer();
  zoomContainer.appendChild(geolocateBtn);

  const panelHandleContainer = document.querySelector('.panel-handle-container');
  const filterPanel = document.querySelector('.filter-panel');

  const togglePanel = () => {
    if (!filterPanel) {
      return;
    }
    if (filterPanel.classList.contains('collapsed')) {
      expandFilterPanel();
    } else {
      collapseFilterPanelAnimated();
    }
  };

  const handleTouchEnd = (e) => {
    if (!touchStartY) {
      return;
    }
    const deltaY = e.changedTouches[0].clientY - touchStartY;
    const threshold = 15;
    if (deltaY > threshold) {
      collapseFilterPanelAnimated();
      restoreFilterPanelAfterCreation();
    } else if (deltaY < -threshold) {
      expandFilterPanel();
      restoreFilterPanelAfterCreation();
    }
    touchStartY = null;
  };

  if (panelHandleContainer) {
    panelHandleContainer.addEventListener('click', togglePanel);
    panelHandleContainer.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        togglePanel();
      }
    });
    panelHandleContainer.addEventListener('touchstart', (event) => {
      touchStartY = event.changedTouches[0].clientY;
    });
    panelHandleContainer.addEventListener('touchend', handleTouchEnd);
  }

  map.on('click', function (e) {
    logFilterPanelState('map-click-start', { lat: e?.latlng?.lat, lng: e?.latlng?.lng });
    if (window.currentCreationMarker) {
      logFilterPanelState('map-click-with-existing-creation-marker');
      clearCreationMarker();
      restoreFilterPanelAfterCreation();
      return;
    }

    if (!isAuthenticated()) {
      showUserToast('Войдите или зарегистрируйтесь, чтобы добавлять метки.');
      return;
    }

    if (isAnyExistingPinPopupOpen()) {
      return;
    }

    if (hasReachedUserMarkerLimit()) {
      showUserToast(USER_LIMIT_MESSAGE);
      return;
    }

    const now = Date.now();
    if (now - lastNonCreationPopupCloseAt < POPUP_REOPEN_GUARD_MS) {
      return;
    }

    placeCreationMarker(e.latlng);
  });

  const resetBtn = document.getElementById('reset-btn');

  categoryChips = Array.from(document.querySelectorAll('.category-chip'));
  categoryChips.forEach((chip) => {
    const slug = chip.dataset.categorySlug;
    const isInitiallyActive = slug ? activeCategorySlugs.has(slug) : false;
    chip.classList.toggle('is-active', isInitiallyActive);
    chip.setAttribute('aria-pressed', String(isInitiallyActive));
    chip.addEventListener('click', () => {
      if (!slug) {
        return;
      }
      if (activeCategorySlugs.has(slug)) {
        activeCategorySlugs.delete(slug);
      } else {
        activeCategorySlugs.add(slug);
      }
      showAllMode = areAllCategoriesActive() ? SHOW_ALL_MODES.ALL : SHOW_ALL_MODES.OFF;
      updateFiltersUi();
    });
  });

  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      if (activeCategorySlugs.size === 0) {
        return;
      }
      deactivateAllCategories();
      showAllMode = SHOW_ALL_MODES.OFF;
      updateFiltersUi();
    });
  }

  showAllBtn = document.getElementById('show-all-btn');
  if (showAllBtn) {
    showAllBtn.addEventListener('click', (event) => {
      event.preventDefault();
      setShowAllMode();
    });
    updateFiltersUi();
  }

  refreshBtn = document.getElementById('refresh-btn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      refreshMarkers();
    });
  }

  filterPanelElement = filterPanel;

  map.on('locationerror', () => {
    alert('Не удалось определить ваше местоположение.');
    removeUserAccuracyCircle();
  });

  updateCounters();

  refreshMarkers();
  startAutoRefresh();
});

document.addEventListener('click', function (e) {
  const categoryBtn = e.target.closest('.creation-popup__category');
  if (categoryBtn) {
    e.preventDefault();
    const slug = categoryBtn.dataset.categorySlug;
    const group = getCategoryBySlug(slug);
    if (!slug || !group) {
      return;
    }
    creationSelection.categorySlug = slug;
    creationSelection.subcategorySlug = group.subcategories?.[0]?.slug || slug;
    const row = categoryBtn.closest('.creation-popup__category-row');
    if (row) {
      row.dataset.selectedCategory = slug;
      row.querySelectorAll('.creation-popup__category').forEach((button) => {
        button.classList.toggle('is-selected', button === categoryBtn);
      });
    }
    if (window.currentCreationMarker) {
      const newColor = colorForCategorySlug(slug);
      window.currentCreationMarker.setStyle({ color: newColor, fillColor: newColor });
    }
    return;
  }

  if (e.target && e.target.classList.contains('creation-popup__save')) {
    if (!window.currentCreationMarker) {
      return;
    }
    const latlng = window.currentCreationMarker.getLatLng();
    handleCreationSubmit(latlng, document.querySelector('.creation-popup'), e.target);
    return;
  }

  const shareButton = e.target.closest('.popup-share');
  if (shareButton) {
    e.preventDefault();
    const shareUrl = shareButton.dataset.shareUrl;
    if (shareUrl) {
      shareLinkWithSystem(shareUrl);
    }
    return;
  }

  const deleteBtn = e.target.closest('.delete-pin-btn');
  if (deleteBtn) {
    e.preventDefault();
    const pinId = Number(deleteBtn.dataset.pinId);
    if (pinId) {
      handleDeletePin(pinId);
    }
    return;
  }

  const deleteCommentBtn = e.target.closest('.pin-comment__delete');
  if (deleteCommentBtn) {
    e.preventDefault();
    const pinId = Number(deleteCommentBtn.dataset.pinId);
    const commentId = deleteCommentBtn.dataset.commentId;
    if (pinId && commentId) {
      handleDeleteComment(pinId, commentId);
    }
  }

  const filterCategoryChip = e.target.closest('.category-chip');
  if (filterCategoryChip) {
    const panel = getFilterPanelElement();
    logFilterPanelState('category-chip-click', {
      chipSlug: filterCategoryChip.dataset.categorySlug || null,
      panelHasMinimizedClass: panel ? panel.classList.contains('minimized') : false,
    });
  }
});

document.addEventListener('submit', (event) => {
  const form = event.target.closest('.pin-comments__form');
  if (!form) {
    return;
  }
  event.preventDefault();
  const pinId = Number(form.dataset.pinId);
  const input = form.querySelector('input[name="comment"]');
  if (!pinId || !input) {
    return;
  }
  const text = input.value.trim();
  if (!text) {
    return;
  }
  if (text.length > COMMENT_MAX_LENGTH) {
    showUserToast(`Комментарий не должен превышать ${COMMENT_MAX_LENGTH} символов.`);
    return;
  }
  submitComment(pinId, text, form, input);
});

function attachCommentHandlers(pinId) {
  const popup = document.querySelector(`.pin-popup[data-pin-id="${pinId}"]`);
  if (!popup) {
    return;
  }
  const form = popup.querySelector('.pin-comments__form');
  if (form) {
    const input = form.querySelector('input[name="comment"]');
    if (input && isTouchDevice) {
      input.addEventListener('focus', () => {
        popup.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    }
  }
}

function submitComment(pinId, text, form, input) {
  if (!isAuthenticated()) {
    showUserToast('Войдите, чтобы оставлять комментарии.');
    return;
  }
  const submitButton = form.querySelector('button[type="submit"]');
  if (submitButton) {
    submitButton.disabled = true;
  }
  fetch('/add_comment', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'same-origin',
    body: JSON.stringify({ marker_id: pinId, text }),
  })
    .then(handleJsonResponse)
    .then((data) => {
      if (!data.comments) {
        return;
      }
      applyCommentsUpdate(pinId, data.comments, { forceScroll: true, animateNew: true });
      if (input) {
        input.value = '';
      }
    })
    .catch((error) => {
      showUserToast(error.message || 'Не удалось отправить комментарий.');
    })
    .finally(() => {
      if (submitButton) {
        submitButton.disabled = false;
      }
    });
}

function handleDeleteComment(pinId, commentId) {
  if (!isAuthenticated()) {
    showUserToast('Нужно войти в аккаунт, чтобы удалять комментарии.');
    return;
  }
  fetch('/delete_comment', {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'same-origin',
    body: JSON.stringify({ marker_id: pinId, comment_id: commentId }),
  })
    .then(handleJsonResponse)
    .then((data) => {
      if (!data.comments) {
        return;
      }
      applyCommentsUpdate(pinId, data.comments, { animateNew: false });
    })
    .catch((error) => {
      showUserToast(error.message || 'Не удалось удалить комментарий.');
    });
}

function handleJsonResponse(response) {
  if (response.ok) {
    return response.json();
  }
  return response
    .json()
    .catch(() => ({}))
    .then((payload) => {
      const message = payload?.description || payload?.message || `Ошибка (HTTP ${response.status})`;
      throw new Error(message);
    });
}

function updateCommentsUI(pinId, comments) {
  applyCommentsUpdate(pinId, comments, { forceScroll: true, animateNew: true });
}
function expandFilterPanel() {
  const panel = getFilterPanelElement();
  if (!panel) {
    return;
  }
  panel.classList.remove('collapsing');
  panel.classList.remove('collapsed');
  panel.classList.remove('minimized');
}

function collapseFilterPanelAnimated() {
  const panel = getFilterPanelElement();
  if (!panel || panel.classList.contains('collapsed')) {
    return;
  }
  ensureProfileViewMode();
  panel.classList.add('collapsing');
  const handleTransitionEnd = (event) => {
    if (event.target !== panel) {
      return;
    }
    panel.classList.remove('collapsing');
    panel.removeEventListener('transitionend', handleTransitionEnd);
  };
  panel.addEventListener('transitionend', handleTransitionEnd);
  requestAnimationFrame(() => {
    panel.classList.add('collapsed');
  });
}
