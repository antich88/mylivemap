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
const ACTIVE_PINS_CLOCK_INTERVAL = 60_000;
const SUBSCRIPTION_STORAGE_KEY = 'liveMapSubscribedAuthors';

// Конфигурация уровней репутации (ключи строго числовые 1–5)
const REPUTATION_LEVELS_CONFIG = {
  1: { key: 'novice', label: 'Новичок', icon: '🌱', bgColor: '#9e9e9e', bgGradient: 'linear-gradient(90deg, #9e9e9e, #b0bec5)' },
  2: { key: 'active', label: 'Активный', icon: '⚡', bgColor: '#4caf50', bgGradient: 'linear-gradient(90deg, #43a047, #66bb6a)' },
  3: { key: 'verified', label: 'Проверенный', icon: '🛡', bgColor: '#2196f3', bgGradient: 'linear-gradient(90deg, #1e88e5, #42a5f5)' },
  4: { key: 'expert', label: 'Эксперт', icon: '👑', bgColor: '#9c27b0', bgGradient: 'linear-gradient(90deg, #8e24aa, #ba68c8)' },
  5: { key: 'legend', label: 'Легенда', icon: '💎', bgColor: '#ffd700', bgGradient: 'linear-gradient(90deg, #ffd700, #ffa000)' },
};
let levelUpAckedOnce = false;

function getReputationLevelConfig(levelRaw) {
  const levelNumber = Number(levelRaw);
  if (Number.isNaN(levelNumber)) {
    return null;
  }
  return REPUTATION_LEVELS_CONFIG[levelNumber] || REPUTATION_LEVELS_CONFIG[1] || null;
}
let subscriptionsFilterActive = false;
const subscribedAuthorNicknames = new Set();
let updateSubscribeButtonState = () => {};

function clearCategorySelections() {
  activeCategorySlugs.clear();
  categoryChips.forEach((chip) => {
    if (chip.dataset.subscribeChip === 'true') {
      return;
    }
    chip.classList.remove('is-active');
    chip.setAttribute('aria-pressed', 'false');
  });
}

function isPinFromSubscribedAuthor(pin) {
  if (!pin) {
    return false;
  }
  const nickname = pin.author?.nickname || pin.user_id || pin.nickname || '';
  const normalized = normalizeNicknameForComparison(nickname);
  return normalized ? subscribedAuthorNicknames.has(normalized) : false;
}

function setSubscriptionsMode(active, { silent = false } = {}) {
  if (active === subscriptionsFilterActive) {
    if (!active && !silent) {
      updateFiltersUi();
    }
    return;
  }
  subscriptionsFilterActive = active;
  if (active) {
    console.log('--- MODE: Subscriptions Active ---');
    clearCategorySelections();
    showAllMode = SHOW_ALL_MODES.OFF;
    applySubscriptionFilters();
  }
  updateSubscribeButtonState();
  if (silent) {
    return;
  }
  updateFiltersUi();
}
let initialSubscriptionsLoaded = false;
let subscriptions = [];
let subscriptionsSectionEl = null;
let subscriptionsListEl = null;
let subscriptionsCountEl = null;
let authorPanelCurrentNickname = '';

window.userLocationMarker = null;
let userLocationIcon = null;
let map;
let pendingSharedPinToken = null;
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
let ignorePanelHandleClick = false;
let createSheetState = {
  isOpen: false,
  latlng: null,
  selectedCategorySlug: null,
  selectedSubcategorySlug: null,
};
let currentAuthorSheetPinId = null;
const pinTimerHandles = new Map();

function formatRemainingTime(secondsLeft) {
  const NORMAL_COLOR = '#9CA3AF';
  const WARNING_COLOR = '#F59E0B';
  const URGENT_COLOR = '#EF4444';
  if (secondsLeft === null || secondsLeft === undefined || Number.isNaN(secondsLeft)) {
    return { text: 'Бессрочно', color: NORMAL_COLOR, urgent: false };
  }
  if (secondsLeft <= 0) {
    return { text: 'Истекло', color: URGENT_COLOR, urgent: false };
  }
  const minutesLeft = Math.max(0, Math.floor(secondsLeft / 60));
  if (minutesLeft >= 60) {
    const hours = Math.floor(minutesLeft / 60);
    const mins = minutesLeft % 60;
    const parts = [
      `${hours}ч`,
    ];
    if (mins > 0) {
      parts.push(`${mins}м`);
    }
    const text = `Осталось ${parts.join(' ')}`;
    return { text, color: NORMAL_COLOR, urgent: false };
  }
  if (minutesLeft >= 5) {
    return { text: `Осталось ${minutesLeft}м`, color: WARNING_COLOR, urgent: false };
  }
  const displayMinutes = minutesLeft > 0 ? minutesLeft : 1;
  return { text: `Осталось ${displayMinutes}м!`, color: URGENT_COLOR, urgent: true };
}

function updateTimerElement(el, info) {
  if (!el) {
    return;
  }
  el.textContent = info.text;
  el.style.color = info.color;
  el.classList.toggle('timer-urgent', info.urgent);
}

function clearPinTimer(pinId) {
  if (!pinId) {
    return;
  }
  const handle = pinTimerHandles.get(pinId);
  if (handle) {
    clearTimeout(handle);
    pinTimerHandles.delete(pinId);
  }
}

function startPinTimer(pinId, initialSeconds, element) {
  clearPinTimer(pinId);
  if (!element) {
    return;
  }
  const seconds = typeof initialSeconds === 'number' && !Number.isNaN(initialSeconds)
    ? Math.max(0, initialSeconds)
    : null;
  const info = formatRemainingTime(seconds);
  updateTimerElement(element, info);
  if (seconds === null || seconds <= 0) {
    return;
  }
  let remainingSeconds = seconds;
  let lastUpdate = Date.now();

  const scheduleNextTick = () => {
    const intervalMs = remainingSeconds <= 5 * 60 ? 10000 : 30000;
    const timerId = setTimeout(() => {
      const now = Date.now();
      const elapsedSeconds = Math.max(1, Math.floor((now - lastUpdate) / 1000));
      lastUpdate = now;
      remainingSeconds = Math.max(0, remainingSeconds - elapsedSeconds);
      const nextInfo = formatRemainingTime(remainingSeconds);
      updateTimerElement(element, nextInfo);
      if (remainingSeconds <= 0) {
        clearPinTimer(pinId);
        return;
      }
      scheduleNextTick();
    }, intervalMs);
    pinTimerHandles.set(pinId, timerId);
  };

  scheduleNextTick();
}

function initializePinTimer(pin) {
  if (!pin || !pin.id) {
    return;
  }
  const timerEl = document.querySelector(`.pin-detail-card__ttl[data-pin-timer="${pin.id}"]`);
  if (!timerEl) {
    return;
  }
  const ttlSeconds = typeof pin.ttl_seconds === 'number' && !Number.isNaN(pin.ttl_seconds)
    ? Math.max(0, pin.ttl_seconds)
    : null;
  startPinTimer(pin.id, ttlSeconds, timerEl);
}
let createPreviewMarker = null;
let createSheetElements = null;
let createSheetInitialized = false;
const createSheetSelectors = {
  sheetId: 'create-sheet',
  backdropId: 'create-sheet-backdrop',
  formId: 'create-sheet-form',
  titleInputId: 'create-title-input',
};

function getCreateSheetParts() {
  if (createSheetElements && createSheetElements.sheet?.isConnected) {
    return createSheetElements;
  }
  createSheetElements = {
    sheet: document.getElementById(createSheetSelectors.sheetId),
    backdrop: document.getElementById(createSheetSelectors.backdropId),
    form: document.getElementById(createSheetSelectors.formId),
    titleInput: document.getElementById(createSheetSelectors.titleInputId),
  };
  return createSheetElements;
}

function resetCreateSheetState() {
  createSheetState.isOpen = false;
  createSheetState.latlng = null;
  createSheetState.selectedCategorySlug = null;
  createSheetState.selectedSubcategorySlug = null;
  closeCreateCategoryDropdown();
}

function updateCreatePreviewMarker(latlng, color) {
  if (!latlng) {
    return;
  }
  const html = `<div class="create-preview-marker" style="--preview-color: ${color}"></div>`;
  const icon = L.divIcon({
    className: 'preview-marker-wrapper',
    html,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  });

  if (createPreviewMarker) {
    createPreviewMarker.setLatLng(latlng);
    createPreviewMarker.setIcon(icon);
    if (!map.hasLayer(createPreviewMarker)) {
      createPreviewMarker.addTo(map);
    }
  } else {
    createPreviewMarker = L.marker(latlng, {
      icon,
      interactive: false,
      zIndexOffset: 2000,
    }).addTo(map);
  }
}

function populateCategoryDropdownPanel() {
  const panel = document.getElementById('create-category-panel');
  if (!panel) {
    return;
  }
  panel.innerHTML = '';
  const fragment = document.createDocumentFragment();
  categoriesData.forEach((category) => {
    if (!category || !category.slug) {
      return;
    }
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'create-dropdown__option';
    option.dataset.slug = category.slug;
    const iconSpan = document.createElement('span');
    iconSpan.className = 'create-dropdown__option-icon';
    iconSpan.setAttribute('aria-hidden', 'true');
    iconSpan.textContent = category.icon || '';
    iconSpan.style.backgroundColor = category.color || 'transparent';

    const labelSpan = document.createElement('span');
    labelSpan.className = 'create-dropdown__option-label';
    labelSpan.textContent = category.label || category.name || '';

    option.append(iconSpan, labelSpan);
    fragment.appendChild(option);
  });
  panel.appendChild(fragment);
}

function setSelectedCategory(slug) {
  if (!slug) {
    return;
  }
  const category = categoriesData.find((item) => item.slug === slug);
  if (!category) {
    return;
  }
  createSheetState.selectedCategorySlug = slug;
  const [defaultSubcategory] = category.subcategories || [];
  createSheetState.selectedSubcategorySlug = defaultSubcategory?.slug || `${slug}.default`;
  const labelEl = document.getElementById('create-category-label');
  if (labelEl) {
    labelEl.textContent = category.label || category.name || '';
  }
  const iconEl = document.getElementById('create-category-icon');
  if (iconEl) {
    iconEl.textContent = category.icon || '';
    iconEl.style.backgroundColor = category.color || 'transparent';
  }

  document.querySelectorAll('.create-dropdown__option').forEach((opt) => {
    if (opt.dataset.slug === slug) {
      opt.classList.add('is-selected');
    } else {
      opt.classList.remove('is-selected');
    }
  });

  if (createPreviewMarker && createSheetState.latlng) {
    const categoryColor = category.color || '#4ade80';
    updateCreatePreviewMarker(createSheetState.latlng, categoryColor);
  }
}

function getCreateCategoryDropdownElements() {
  return {
    trigger: document.getElementById('create-category-trigger'),
    panel: document.getElementById('create-category-panel'),
  };
}

function closeCreateCategoryDropdown() {
  const { panel, trigger } = getCreateCategoryDropdownElements();
  if (!panel || panel.hasAttribute('hidden')) {
    return;
  }
  panel.setAttribute('hidden', '');
  if (trigger) {
    trigger.setAttribute('aria-expanded', 'false');
  }
}

function openCreateCategoryDropdown() {
  const { panel, trigger } = getCreateCategoryDropdownElements();
  if (!panel) {
    return;
  }
  panel.removeAttribute('hidden');
  if (trigger) {
    trigger.setAttribute('aria-expanded', 'true');
  }
}

function toggleCreateCategoryDropdown() {
  const { panel } = getCreateCategoryDropdownElements();
  if (!panel) {
    return;
  }
  if (panel.hasAttribute('hidden')) {
    openCreateCategoryDropdown();
    return;
  }
  closeCreateCategoryDropdown();
}

function attachCategoryDropdownHandlers() {
  if (attachCategoryDropdownHandlers.__bound) {
    return;
  }
  attachCategoryDropdownHandlers.__bound = true;
  const { trigger, panel } = getCreateCategoryDropdownElements();
  if (trigger) {
    trigger.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleCreateCategoryDropdown();
    });
  }
  if (panel) {
    panel.addEventListener('click', (event) => {
      const option = event.target.closest('.create-dropdown__option');
      if (!option) {
        return;
      }
      event.stopPropagation();
      const optionSlug = option.dataset.slug;
      if (optionSlug) {
        setSelectedCategory(optionSlug);
      }
      closeCreateCategoryDropdown();
    });
  }
  document.addEventListener('click', (event) => {
    const clickedTarget = event.target;
    if (!panel || panel.hasAttribute('hidden')) {
      return;
    }
    if (trigger && (trigger === clickedTarget || trigger.contains(clickedTarget))) {
      return;
    }
    if (panel.contains(clickedTarget)) {
      return;
    }
    closeCreateCategoryDropdown();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeCreateCategoryDropdown();
    }
  });
}

function closeCreateSheet() {
  const { sheet, backdrop, form } = getCreateSheetParts();
  if (sheet) {
    sheet.style.transform = '';
    sheet.style.transition = '';
  }
  if (sheet) {
    sheet.setAttribute('hidden', '');
  }
  if (backdrop) {
    backdrop.setAttribute('hidden', '');
  }
  if (form) {
    form.reset();
  }
  if (createPreviewMarker) {
    createPreviewMarker.remove();
    createPreviewMarker = null;
  }
  resetCreateSheetState();
}

function openCreateSheet(latlng) {
  if (!latlng) return;
  const { sheet, backdrop, titleInput } = getCreateSheetParts();
  createSheetState.latlng = latlng;
  createSheetState.isOpen = true;

  let defaultColor = '#4ade80';
  if (categoriesData.length) {
    defaultColor = categoriesData[0].color || defaultColor;
    setSelectedCategory(categoriesData[0].slug);
  }

  updateCreatePreviewMarker(latlng, defaultColor);

  if (sheet) sheet.removeAttribute('hidden');
  if (backdrop) backdrop.removeAttribute('hidden');

  setTimeout(() => {
    const sheetEl = document.getElementById('create-sheet');
    const sheetHeight = sheetEl ? sheetEl.offsetHeight : (window.innerHeight * 0.6);
    const markerPoint = map.project(latlng, map.getZoom());
    const targetPoint = markerPoint.add(L.point(0, Math.floor(sheetHeight / 2)));
    const targetLatLng = map.unproject(targetPoint, map.getZoom());
    map.setView(targetLatLng, map.getZoom(), { animate: true, duration: 0.4 });
  }, 50);

}
const VOTE_DIRECTION_VALUES = {
  up: 1,
  down: -1,
};
const PROFILE_BUTTON_STATES = {
  PROFILE: 'profile',
  AUTHOR: 'author',
  AUTH: 'auth',
  COLLAPSED: 'collapsed',
};
let currentUserVotes = new Map();
const voteInFlightPins = new Set();
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
let activePinsClockId = null;
let activePinsElementsCache = null;

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

function minimizeFilterPanelForPinPopup() {
  minimizeFilterPanelForMobile('pin-popup');
}

function collapseDesktopPanels() {
  if (isMobileViewport()) {
    return;
  }
  collapseFilterPanelAnimated();
  setAuthPanelVisibility(false);
  toggleUserPanelExpandedState(false);
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
    if (chip.dataset.subscribeChip === 'true') {
      return;
    }
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
      populateVoteState(pins);
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

  marker.setLatLng([pin.lat, pin.lng]);

  if (typeof marker.setIcon === 'function') {
    marker.setIcon(createMarkerLabelIcon(pin));
  }

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
  const inputEl = popupEl ? popupEl.querySelector('.pin-comments__form-modern input[name="comment"]') : null;
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

    const inputEl = popupEl.querySelector('.pin-comments__form-modern input[name="comment"]');
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

function renderPinAuthorIntro(pin, isSelf = false) {
  const author = pin.author || {};
  const nickname = author.nickname || pin.user_id || pin.nickname || 'Автор';
  const safeNickname = escapeHtml(nickname);
  const authorId = author.nickname || pin.user_id || pin.nickname || '';
  const safeAuthorId = escapeHtml(authorId);
  const avatarUrl = author.avatar_url || pin.avatar_url;
  const avatarMarkup = avatarUrl
    ? `<img src="${avatarUrl}" alt="Аватар ${safeNickname}" loading="lazy" />`
    : `<span class="pin-popup__author-avatar-placeholder">${safeNickname.charAt(0).toUpperCase()}</span>`;

  const indicators = renderAuthorIndicators(author);
  const badge = renderReputationBadge(author);

  return `
    <div class="pin-popup__author">
      <div class="pin-popup__author-avatar" aria-hidden="true">
        ${avatarMarkup}
      </div>
      <div class="pin-popup__author-info">
        <span class="pin-popup__author-label">Автор</span>
        <button
          type="button"
          class="pin-popup__author-nickname-btn"
          data-author-panel-trigger
          data-author-self="${isSelf ? 'true' : 'false'}"
          data-author-link
          data-author-id="${safeAuthorId}"
        >
          <span class="pin-popup__author-link author-inline">
            <span class="pin-popup__author-nickname author-inline__name">${safeNickname}</span>
            <span class="author-inline__name-icons">${indicators}</span>
          </span>
        </button>
        ${badge}
      </div>
    </div>
  `;
}

function renderReputationBadge(author = {}) {
  const levelRaw = author.reputation_level;
  if (levelRaw === null || levelRaw === undefined) {
    return '';
  }
  const config = getReputationLevelConfig(levelRaw);
  if (!config) {
    return '';
  }
  const background = config.bgGradient || config.bgColor || '#4caf50';
  const authorId = escapeHtml(author.nickname || author.user_id || author.authorNick || '');
  const isSelf = authorId && currentAuthUser?.nickname === authorId;
  return `
    <button
      type="button"
      class="pin-popup__author-badge pin-popup__author-badge--${config.key}"
      style="background:${background}"
      data-author-panel-trigger
      data-author-id="${authorId}"
      data-author-self="${isSelf ? 'true' : 'false'}"
    >
      <span class="pin-popup__author-badge-icon" aria-hidden="true">${config.icon}</span>
      <span class="pin-popup__author-badge-text">${escapeHtml(config.label)}</span>
    </button>
  `;
}

function renderAuthorIndicators(author = {}) {
  const parts = [];
  if (author.is_verified) {
    parts.push(`<span class="author-inline__verified" aria-label="Проверенный автор" title="Проверенный автор">✓</span>`);
  }
  if (author.is_active_recently) {
    parts.push(`<span class="author-inline__active-recently" aria-label="Активен недавно" title="Активен недавно">🔥</span>`);
  }
  if (!parts.length) {
    return '';
  }
  return parts.join('');
}

function buildPinAuthorInfo(pin) {
  const author = (pin.author && typeof pin.author === 'object') ? pin.author : {};
  const nickname = author.nickname || pin.user_id || pin.nickname || 'Автор';
  const avatar_url = author.avatar_url || pin.avatar_url || '';
  const rating_total = typeof author.rating_total === 'number' ? author.rating_total : null;
  const reputation_level = author.reputation_level || author.reputation_level === 0 ? author.reputation_level : null;
  const reputation_points = typeof author.reputation_points === 'number' ? author.reputation_points : null;
  const is_verified = Boolean(author.is_verified);
  const is_active_recently = Boolean(author.is_active_recently);
  const age = typeof author.age === 'number' ? author.age : null;
  const gender = typeof author.gender === 'string' ? author.gender : null;
  return { nickname, avatar_url, rating_total, reputation_level, reputation_points, is_verified, is_active_recently, age, gender };
}

function getAuthorPanelElements() {
  const panel = document.querySelector('.user-panel');
  if (!panel) {
    return {};
  }
  return {
    panel,
    authorView: panel.querySelector('[data-author-view]'),
    userContent: panel.querySelector('[data-user-content]'),
    authorAvatar: panel.querySelector('[data-author-avatar]'),
    authorName: panel.querySelector('[data-author-name]'),
    authorRating: panel.querySelector('[data-author-rating]'),
    authorAge: panel.querySelector('[data-author-age]'),
    authorGender: panel.querySelector('[data-author-gender]'),
    authorClose: panel.querySelector('[data-author-action="close"]'),
  };
}

function getAuthorSheetElements() {
  const sheet = document.getElementById('author-sheet');
  if (!sheet) {
    return {};
  }
  return {
    panel: sheet,
    backdrop: document.getElementById('author-sheet-backdrop'),
    authorAvatar: sheet.querySelector('[data-author-avatar]'),
    authorName: sheet.querySelector('[data-author-name]'),
    authorRating: sheet.querySelector('[data-author-rating]'),
    authorAge: sheet.querySelector('[data-author-age]'),
    authorGender: sheet.querySelector('[data-author-gender]'),
    closeButton: document.getElementById('author-sheet-close'),
  };
}

function syncAuthorCloseButtonLabel() {
  const closeBtn = document.querySelector('[data-author-action="close"]');
  if (!closeBtn) {
    return;
  }
  const authLabel = closeBtn.dataset.authorCloseAuth || '← Назад к профилю';
  const guestLabel = closeBtn.dataset.authorCloseGuest || '← Назад';
  closeBtn.textContent = isAuthenticated() ? authLabel : guestLabel;
}

function formatAuthorRating(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === 'string' && value.trim().length) {
    return value;
  }
  return '—';
}

function formatAuthorAge(value) {
  if (value === null || value === undefined || value === '') {
    return '—';
  }
  if (Number.isFinite(value)) {
    return String(value);
  }
  const coercedNumber = Number(value);
  if (!Number.isNaN(coercedNumber)) {
    return String(coercedNumber);
  }
  const normalized = String(value).trim();
  return normalized.length ? normalized : '—';
}

function formatAuthorGender(value) {
  if (!value) {
    return '—';
  }
  const normalized = String(value).trim().toUpperCase();
  return PROFILE_GENDER_LABELS[normalized] || '—';
}

function renderAuthorAvatar(author) {
  const { authorAvatar } = getAuthorSheetElements();
  if (!authorAvatar) {
    return;
  }
  const nickname = author.nickname || 'Автор';
  const letter = nickname.trim().charAt(0).toUpperCase() || 'А';
  authorAvatar.innerHTML = '';
  if (author.avatar_url) {
    const img = document.createElement('img');
    img.src = author.avatar_url;
    img.alt = `Аватар ${nickname}`;
    img.loading = 'lazy';
    authorAvatar.appendChild(img);
  } else {
    const placeholder = document.createElement('span');
    placeholder.className = 'pin-popup__author-avatar-placeholder';
    placeholder.textContent = letter;
    authorAvatar.appendChild(placeholder);
  }
}

function normalizeNicknameForComparison(nickname) {
  return (nickname || '').trim().toLowerCase();
}

function resolveAuthorPanelNickname(author) {
  if (!author) {
    return '';
  }
  return (author.nickname || author.authorNick || author.user_id || '').trim();
}

function isNicknameSubscribed(nickname) {
  const normalized = normalizeNicknameForComparison(nickname);
  return normalized ? subscribedAuthorNicknames.has(normalized) : false;
}

function refreshAuthorPanelSubscribeButtonState() {
  const subscribeBtn = document.querySelector('.author-panel__subscribe-btn');
  if (!subscribeBtn) {
    return;
  }
  const subscribed = isNicknameSubscribed(authorPanelCurrentNickname);
  subscribeBtn.textContent = subscribed ? 'Отписаться' : 'Подписаться';
  subscribeBtn.classList.toggle('author-panel__subscribe-btn--active', subscribed);
  subscribeBtn.dataset.authorSubscribed = subscribed ? 'true' : 'false';
}

function toggleAuthorPanelSubscription() {
  const nickname = (authorPanelCurrentNickname || '').trim();
  if (!nickname) {
    return;
  }
  const subscribed = isNicknameSubscribed(nickname);
  const url = subscribed ? `/api/subscriptions/${encodeURIComponent(nickname)}` : '/api/subscriptions';
  const options = {
    method: subscribed ? 'DELETE' : 'POST',
    credentials: 'same-origin',
  };
  if (!subscribed) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify({ author_nickname: nickname });
  }
  fetch(url, options)
    .then(handleJsonResponse)
    .then(() => {
      showUserToast(subscribed ? `Подписка на ${nickname} отменена.` : `Вы подписались на ${nickname}.`);
      return fetchSubscriptions();
    })
    .then(() => {
      applySubscriptionFilters();
      refreshAuthorPanelSubscribeButtonState();
    })
    .catch((error) => {
      showUserToast(error.message || (subscribed ? 'Не удалось отменить подписку.' : 'Не удалось подписаться.'));
    });
}

function updateAuthorPanelContent(author) {
  const { authorName, authorRating, authorAge, authorGender } = getAuthorSheetElements();
  if (authorName) {
    authorName.textContent = author.nickname || 'Автор';
  }
  if (authorRating) {
    authorRating.textContent = formatAuthorRating(author.rating_total);
  }
  if (authorAge) {
    authorAge.textContent = formatAuthorAge(author.age);
  }
  if (authorGender) {
    authorGender.textContent = formatAuthorGender(author.gender);
  }
  renderAuthorAvatar(author);
}

function bindAuthorPanelSubscribeButton(author) {
  const authorSubscribeBtn = document.querySelector('.author-panel__subscribe-btn');
  if (!authorSubscribeBtn) {
    return;
  }
  authorPanelCurrentNickname = resolveAuthorPanelNickname(author);
  const handleSubscribeClick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleAuthorPanelSubscription();
  };
  if (authorSubscribeBtn.__authorSubscribeHandler) {
    authorSubscribeBtn.removeEventListener('click', authorSubscribeBtn.__authorSubscribeHandler);
  }
  authorSubscribeBtn.__authorSubscribeHandler = handleSubscribeClick;
  authorSubscribeBtn.addEventListener('click', handleSubscribeClick);
  refreshAuthorPanelSubscribeButtonState();
}

let isAuthorSheetClosing = false;
let ignoreMapClicksUntil = 0;
let lastAuthorSheetClosedAt = 0;

function closeAuthorSheet() {
  const sheet = document.getElementById('author-sheet');
  const backdrop = document.getElementById('author-sheet-backdrop');
  const content = document.getElementById('author-sheet-content');

  if (currentAuthorSheetPinId) {
    stopCommentPolling(currentAuthorSheetPinId);
    currentAuthorSheetPinId = null;
  }

  isAuthorSheetClosing = true;
  ignoreMapClicksUntil = Date.now() + 400;
  lastAuthorSheetClosedAt = Date.now();

  if (sheet) {
    sheet.style.transition = 'transform 0.35s cubic-bezier(0.32, 0.72, 0, 1)';
    sheet.style.transform = 'translateY(100%)';
    setTimeout(() => {
      sheet.setAttribute('hidden', '');
      if (content) {
        content.innerHTML = '';
      }
      sheet.style.transform = '';
      sheet.style.transition = '';
      isAuthorSheetClosing = false;
    }, 350);
  }
  if (backdrop) backdrop.setAttribute('hidden', '');
}

function fetchPinDetails(pinId) {
  if (!pinId) {
    return Promise.resolve(null);
  }
  return fetch(`/api/pins/${pinId}`, { credentials: 'same-origin' })
    .then(handleJsonResponse)
    .catch((error) => {
      console.error('Не удалось получить свежую метку', error);
      return null;
    });
}

function updateActiveMarkerEntry(pin) {
  if (!pin || !pin.id) {
    return;
  }
  const entry = getActiveMarkerEntry(pin.id);
  if (!entry) {
    return;
  }
  entry.pin = pin;
  entry.pinData = {
    ...entry.pinData,
    ...pin,
    rating: pin.rating,
    likes_count: pin.likes_count,
    dislikes_count: pin.dislikes_count,
  };
}

function renderAuthorSheetForPin(pin) {
  if (!pin || !pin.id) {
    return;
  }
  const sheet = document.getElementById('author-sheet');
  const backdrop = document.getElementById('author-sheet-backdrop');
  const content = document.getElementById('author-sheet-content');
  if (!sheet || !content) {
    return;
  }

  content.innerHTML = createPopupContent(pin);
  attachCommentHandlers(pin.id);
  initializeCommentsView(pin.id, pin.comments || []);
  startCommentPolling(pin.id);
  attachAuthorPopupHandlers({ getElement: () => content }, pin);
  initializePinTimer(pin);

  sheet.removeAttribute('hidden');
  if (backdrop) backdrop.removeAttribute('hidden');
  sheet.style.transition = 'none';
  sheet.style.transform = 'translateY(100%)';
  requestAnimationFrame(() => {
    sheet.style.transition = 'transform 0.35s cubic-bezier(0.32, 0.72, 0, 1)';
    sheet.style.transform = 'translateY(0)';
  });

  if (pin.lat !== undefined && pin.lng !== undefined) {
    setTimeout(() => {
      centerMapUnderSheet([pin.lat, pin.lng], sheet);
    }, 60);
  }
}

function openAuthorSheet(pin) {
  if (!pin || !pin.id) {
    return;
  }
  const pinId = pin.id;
  if (currentAuthorSheetPinId && currentAuthorSheetPinId !== pinId) {
    stopCommentPolling(currentAuthorSheetPinId);
    clearPinTimer(currentAuthorSheetPinId);
  }
  currentAuthorSheetPinId = pinId;

  renderAuthorSheetForPin(pin);

  fetchPinDetails(pinId)
    .then((freshPin) => {
      if (!freshPin || currentAuthorSheetPinId !== pinId) {
        return;
      }
      updateActiveMarkerEntry(freshPin);
      updatePopupRating(pinId, freshPin.rating);
      const voteButtons = document.querySelector(`.pin-popup__vote-buttons[data-pin-id="${pinId}"]`);
      if (voteButtons) {
        const likesElem = voteButtons.querySelector('[data-pin-likes-count]');
        const dislikesElem = voteButtons.querySelector('[data-pin-dislikes-count]');
        if (likesElem && Number.isFinite(freshPin.likes_count)) {
          likesElem.textContent = freshPin.likes_count;
        }
        if (dislikesElem && Number.isFinite(freshPin.dislikes_count)) {
          dislikesElem.textContent = freshPin.dislikes_count;
        }
      }
    })
    .catch(console.error);
}

function centerMapUnderSheet(latlng, sheet) {
  if (!map || !latlng || !sheet) {
    return;
  }
  const [lat, lng] = latlng;
  const sheetHeight = sheet.offsetHeight || window.innerHeight * 0.6;
  const markerPoint = map.project([lat, lng], map.getZoom());
  const targetPoint = markerPoint.add(L.point(0, Math.floor(sheetHeight / 2)));
  const targetLatLng = map.unproject(targetPoint, map.getZoom());
  map.setView(targetLatLng, map.getZoom(), { animate: true, duration: 0.4 });
}

function showAuthorPanel(author) {
  const { panel, backdrop } = getAuthorSheetElements();
  if (!panel) {
    return;
  }
  updateAuthorPanelContent(author);
  renderAuthorActivePinsList(author.nickname || '');
  bindAuthorPanelSubscribeButton(author);
  panel.removeAttribute('hidden');
  if (backdrop) {
    backdrop.removeAttribute('hidden');
  }
}

function openAuthorPanel(authorId) {
  const normalizedId = (authorId || '').trim();
  if (!normalizedId) {
    return;
  }
  return fetch(`/api/authors/${encodeURIComponent(normalizedId)}`, { credentials: 'same-origin' })
    .then(handleJsonResponse)
    .then((payload) => {
      const author = payload?.author;
      if (!author) {
        throw new Error('Данные автора не найдены.');
      }
      showAuthorPanel(author);
      return author;
    })
    .catch((error) => {
      showUserToast(error.message || 'Не удалось открыть профиль автора.');
      throw error;
    });
}

function showUserProfilePanel() {
  const { panel, authorView, userContent } = getAuthorPanelElements();
  if (!panel || !userContent) {
    return;
  }
  authorView?.classList.add('is-hidden');
  userContent.classList.remove('is-hidden');
  panel.setAttribute('data-panel-visible', 'profile');
  expandFilterPanel();
  toggleUserPanelExpandedState(true, 'profile');
}

function showGuestAuthPanel() {
  const { panel, authorView, userContent } = getAuthorPanelElements();
  if (!panel || !authorView || !userContent) {
    return;
  }
  authorView.classList.add('is-hidden');
  userContent.classList.add('is-hidden');
  panel.setAttribute('data-panel-visible', 'auth');
  expandFilterPanel();
  toggleUserPanelExpandedState(true, 'auth');
  setAuthPanelVisibility(true);
  syncAuthorCloseButtonLabel();
}

function bindAuthorPanelCloseHandler() {
  const { authorClose } = getAuthorPanelElements();
  if (!authorClose) {
    return;
  }
  if (authorClose.dataset.bound === 'true') {
    return;
  }
  authorClose.dataset.bound = 'true';
  authorClose.addEventListener('click', (event) => {
    event.preventDefault();
    if (!isAuthenticated()) {
      showGuestAuthPanel();
      return;
    }
    showUserProfilePanel();
  });
}

function handleAuthStateChangeForCloseButton(event) {
  syncAuthorCloseButtonLabel();
}


function attachAuthorPopupHandlers(popup, pin) {
  if (!popup) {
    return;
  }
  const popupEl = popup.getElement ? popup.getElement() : null;
  if (!popupEl) {
    return;
  }
  const triggers = popupEl.querySelectorAll('[data-author-panel-trigger]');
  triggers.forEach((trigger) => {
    if (trigger.dataset.authorHandlerBound === 'true') {
      return;
    }
    trigger.dataset.authorHandlerBound = 'true';
    trigger.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const isSelfTrigger = trigger.dataset.authorSelf === 'true';
      if (isSelfTrigger) {
        showUserProfilePanel();
        return;
      }
      const authorId = trigger.dataset.authorId || trigger.dataset.author || '';  // fallback
      if (authorId) {
        openAuthorPanel(authorId);
        return;
      }
      showAuthorPanel(buildPinAuthorInfo(pin));
    });
  });

    const subscribeBtn = popupEl.querySelector('.author-panel__subscribe-btn');
  if (subscribeBtn) {
    subscribeBtn.dataset.authorSubscribe = 'true';
    subscribeBtn.addEventListener('click', (event) => {
      event.preventDefault();
      const nickname = pin.author?.nickname || buildPinAuthorInfo(pin).nickname;
      if (!nickname) {
        return;
      }
      fetch('/api/subscriptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ author_nickname: nickname }),
      })
        .then(handleJsonResponse)
        .then(() => {
          showUserToast(`Вы подписались на ${nickname}.`);
          fetchSubscriptions().then(() => applySubscriptionFilters());
        })
        .catch((error) => {
          showUserToast(error.message || 'Не удалось подписаться.');
        });
    });
  }
}

bindAuthorPanelCloseHandler();

function createPopupContent(pin) {
  const category = getCategoryBySlug(pin.category_slug);
  const currentNickname = currentAuthUser?.nickname || null;
  const pinnedComments = Array.isArray(pin.comments) ? pin.comments : [];
  const commentCount = pinnedComments.length;
  const author = buildPinAuthorInfo(pin);
  const safeNickname = escapeHtml(author.nickname || 'Автор');
  const safeAuthorId = escapeHtml(author.nickname || author.user_id || pin.user_id || '');
  const avatarInitial = (safeNickname.charAt(0) || 'A').toUpperCase();
  const authorAvatarMarkup = author.avatar_url
    ? `<img src="${escapeHtml(author.avatar_url)}" alt="Аватар ${safeNickname}" loading="lazy" class="pin-detail-card__avatar-img" />`
    : `<span class="pin-detail-card__avatar-initial">${avatarInitial}</span>`;
  const commentsList = renderCommentsList(pinnedComments, currentNickname, pin.id);
  const commentForm = renderCommentForm(currentNickname, pin.id);
  const ttlSeconds = typeof pin.ttl_seconds === 'number' && !Number.isNaN(pin.ttl_seconds)
    ? Math.max(0, pin.ttl_seconds)
    : null;
  const initialTimerInfo = formatRemainingTime(ttlSeconds);
  const canDeletePin = Boolean(currentNickname && currentNickname === pin.user_id);

  const voteControlsMarkup = renderVoteControls(pin);
  const voteRowMarkup = `
    <div class="pin-detail-card__vote-row">
      <span class="pin-detail-card__vote-label">Оценить метку:</span>
      ${voteControlsMarkup}
    </div>
  `;

  const deleteButtonMarkup = canDeletePin
    ? `
      <button type="button" class="pin-popup__delete-pin delete-pin-btn" data-pin-id="${pin.id}">
        Удалить метку
      </button>
    `
    : '';

  return `
    <div class="pin-popup pin-detail-card" data-pin-id="${pin.id}">
      <header class="pin-detail-card__header">
        <div class="pin-detail-card__author-row">
          <div class="pin-detail-card__author">
            <div class="pin-detail-card__avatar" aria-hidden="true">
              ${authorAvatarMarkup}
            </div>
          <div class="pin-detail-card__author-meta">
            <button
              type="button"
              class="author-inline pin-detail-card__author-trigger"
              data-author-panel-trigger
              data-author-id="${safeAuthorId}"
              data-author-self="${safeAuthorId && currentAuthUser?.nickname === safeAuthorId ? 'true' : 'false'}"
            >
              <strong class="pin-detail-card__author-name author-inline__name" data-author-name>${safeNickname}</strong>
              <span class="author-inline__name-icons">
                ${renderAuthorIndicators(author)}
              </span>
            </button>
            ${renderReputationBadge(author)}
          </div>
        </div>
          <div class="pin-detail-card__ttl" data-pin-timer="${pin.id}">
            <span class="marker-timer ${initialTimerInfo.urgent ? 'timer-urgent' : ''}" style="color: ${initialTimerInfo.color};">
              ${initialTimerInfo.text}
            </span>
          </div>
        </div>
        ${voteRowMarkup}
      </header>

      <div class="pin-detail-card__title">${escapeHtml(pin.nickname || pin.title || 'Метка')}</div>
      <div class="pin-detail-card__description">
        <p>${escapeHtml(pin.description || 'Описание отсутствует.')}</p>
      </div>

      <section class="pin-detail-card__discussion pin-comments" data-pin-id="${pin.id}">
        <div class="pin-comments__header">
          <span>💬 Обсуждение</span>
          <span class="pin-detail-card__message-count">${commentCount}</span>
        </div>
        ${commentsList}
        ${commentForm}
      </section>

      ${deleteButtonMarkup ? `<div class="pin-detail-card__actions">${deleteButtonMarkup}</div>` : ''}
    </div>
  `;
}

function renderCommentsList(comments, currentNickname, pinId) {
  const normalizedComments = Array.isArray(comments) ? comments : [];
  if (!normalizedComments.length) {
    return '<div class="pin-comments__empty">Комментариев пока нет</div>';
  }
  const items = normalizedComments
    .map((comment) => {
      const canDelete = Boolean(currentNickname && currentNickname === comment.user_id);
      const isOwn = canDelete;
      const authorName = escapeHtml(comment.user_id || 'Аноним');
      const body = escapeHtml(comment.text || '');
      const time = formatTimestamp(comment.timestamp);
      const deleteButton = canDelete
        ? `<button type="button" class="pin-comment__delete" data-pin-id="${pinId}" data-comment-id="${comment.id}" aria-label="Удалить комментарий">Удалить</button>`
        : '';
      return `
        <div class="pin-comment ${isOwn ? 'pin-comment--own' : 'pin-comment--other'}" data-comment-id="${comment.id}">
          <div class="pin-comment__bubble">
            <div class="pin-comment__bubble-header">
              <div class="pin-comment__bubble-meta">
                <span class="pin-comment__author">${authorName}</span>
                <span class="pin-comment__time">${time}</span>
              </div>
              ${deleteButton}
            </div>
            <p class="pin-comment__body">${body}</p>
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

  const bubble = document.createElement('div');
  bubble.className = 'pin-comment__bubble';

  const header = document.createElement('div');
  header.className = 'pin-comment__bubble-header';

  const meta = document.createElement('div');
  meta.className = 'pin-comment__bubble-meta';
  const authorEl = document.createElement('span');
  authorEl.className = 'pin-comment__author';
  authorEl.textContent = comment.user_id || 'Аноним';
  const timeEl = document.createElement('span');
  timeEl.className = 'pin-comment__time';
  timeEl.textContent = formatTimestamp(comment.timestamp);
  meta.append(authorEl, timeEl);

  header.appendChild(meta);
  if (canDelete) {
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'pin-comment__delete';
    deleteBtn.dataset.pinId = String(pinId);
    deleteBtn.dataset.commentId = comment.id;
    deleteBtn.setAttribute('aria-label', 'Удалить комментарий');
    deleteBtn.textContent = 'Удалить';
    header.appendChild(deleteBtn);
  }

  const bodyEl = document.createElement('p');
  bodyEl.className = 'pin-comment__body';
  bodyEl.textContent = comment.text || '';

  bubble.append(header, bodyEl);
  wrapper.appendChild(bubble);
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
    <form class="pin-comments__form-modern" data-pin-id="${pinId}">
      <input type="text" name="comment" placeholder="Написать..." maxlength="${COMMENT_MAX_LENGTH}" autocomplete="off" />
      <button type="submit" class="comment-send-btn" aria-label="Отправить" disabled>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
      </button>
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

function getActivePinsListElement() {
  const section = document.querySelector('[data-active-pins-section]');
  if (!section) {
    return null;
  }
  return section.querySelector('[data-active-pins-list]');
}

function getActivePinsCountElement() {
  const section = document.querySelector('[data-active-pins-section]');
  if (!section) {
    return null;
  }
  return section.querySelector('[data-active-pins-count]');
}

function getAuthorActivePinsListElement() {
  return document.querySelector('[data-author-active-pins-list]');
}

function getAuthorActivePinsCountElement() {
  return document.querySelector('[data-author-active-pins-count]');
}

function getActivePinsByNickname(nickname) {
  if (!nickname) {
    return [];
  }
  return activeMarkers
    .map(({ pin }) => pin)
    .filter((pin) => pin.user_id && pin.user_id === nickname);
}

function getCurrentUserPins() {
  const nickname = currentAuthUser?.nickname;
  if (!nickname) {
    return [];
  }
  return activeMarkers
    .map(({ pin }) => pin)
    .filter((pin) => pin.user_id === nickname);
}

function updateProfileStats(count) {
  const profileCountElement = document.getElementById('profile-active-pins-count');
  if (profileCountElement) {
    profileCountElement.textContent = String(count);
  }
}

function updateFollowersCounter(count) {
  const followersElement = document.getElementById('profile-followers-count');
  if (followersElement) {
    followersElement.textContent = String(count);
  }
}

function getActivePinText(pin) {
  const ttl = typeof pin.ttl_seconds === 'number' && !Number.isNaN(pin.ttl_seconds)
    ? Math.max(0, Math.ceil(pin.ttl_seconds / 60))
    : '∞';
  const rating = Number.isFinite(pin.rating) ? pin.rating : 0;
  return `Рейтинг: ${rating} · Живёт ещё: ${ttl} мин.`;
}

function createActivePinMarkup(pin) {
  const title = escapeHtml(pin.nickname || 'Метка');
  const meta = getActivePinText(pin);
  return `
    <article class="user-panel__active-pin" data-active-pin-id="${pin.id}">
      <a class="user-panel__active-pin-title" href="#" data-active-pin-title data-pin-id="${pin.id}">
        ${title}
      </a>
      <div class="user-panel__active-pin-meta">
        <span>${meta}</span>
      </div>
      <div class="user-panel__active-pin-actions">
        <button type="button" class="user-panel__delete-pin-btn" data-active-pin-delete data-pin-id="${pin.id}">Удалить сейчас</button>
      </div>
    </article>
  `;
}

function createAuthorActivePinMarkup(pin) {
  const title = escapeHtml(pin.nickname || 'Метка');
  const meta = getActivePinText(pin);
  return `
    <article class="user-panel__active-pin author-panel__active-pin" data-author-pin-id="${pin.id}">
      <a class="user-panel__active-pin-title" href="#" data-author-active-pin-link data-pin-id="${pin.id}">
        ${title}
      </a>
      <div class="user-panel__active-pin-meta">
        <span>${meta}</span>
      </div>
    </article>
  `;
}

function renderActivePinsList() {
  const listEl = getActivePinsListElement();
  const countEl = getActivePinsCountElement();
  if (!listEl || !countEl) {
    return;
  }
  const nickname = currentAuthUser?.nickname;
  if (!nickname) {
    listEl.innerHTML = '<p class="user-panel__active-pins-empty">Войдите, чтобы увидеть свои метки.</p>';
    countEl.textContent = `0/${USER_MARKER_LIMIT}`;
    return;
  }
  const pins = getCurrentUserPins();
  countEl.textContent = `${pins.length}/${USER_MARKER_LIMIT}`;
  if (!pins.length) {
    listEl.innerHTML = '<p class="user-panel__active-pins-empty">Активных меток пока нет.</p>';
    return;
  }
  listEl.innerHTML = pins.map((pin) => createActivePinMarkup(pin)).join('');
}

function renderAuthorActivePinsList(nickname) {
  const listEl = getAuthorActivePinsListElement();
  const countEl = getAuthorActivePinsCountElement();
  if (!listEl || !countEl) {
    return;
  }
  const pins = getActivePinsByNickname(nickname);
  countEl.textContent = `${pins.length}/${USER_MARKER_LIMIT}`;
  if (!pins.length) {
    listEl.innerHTML = '<p class="user-panel__active-pins-empty">Активных точек пока нет.</p>';
    return;
  }
  listEl.innerHTML = pins.map((pin) => createAuthorActivePinMarkup(pin)).join('');
  listEl.querySelectorAll('[data-author-active-pin-link]').forEach((link) => {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      const pinId = Number(link.dataset.pinId);
      if (pinId) {
        focusPinFromList(pinId);
      }
    });
  });
}

function ensureSubscriptionElements() {
  if (!subscriptionsSectionEl || !subscriptionsListEl || !subscriptionsCountEl) {
    subscriptionsSectionEl = document.querySelector('[data-subscriptions-section]');
    subscriptionsListEl = document.querySelector('[data-subscriptions-list]');
    subscriptionsCountEl = document.querySelector('[data-subscriptions-count]');
  }
  return { subscriptionsSectionEl, subscriptionsListEl, subscriptionsCountEl };
}

function renderSubscriptionsList() {
  const container = document.getElementById('subscriptions-list');
  if (container) {
    container.className = '';
  }
  const { subscriptionsListEl, subscriptionsCountEl } = ensureSubscriptionElements();
  if (!subscriptionsListEl || !subscriptionsCountEl) {
    return;
  }
  subscriptionsListEl.style.background = 'transparent';
  const count = subscriptions.length;
  subscriptionsCountEl.textContent = String(count);
  if (!count) {
    subscriptionsListEl.innerHTML = '<p class="user-panel__subscriptions-empty">Пока нет подписок.</p>';
    return;
  }
  console.log('--- СУПЕР-ЧИСТКА JS v5 ---');
  subscriptionsListEl.innerHTML = '';
  const fragment = document.createDocumentFragment();
  subscriptions.forEach((subscription) => {
    const nickname = (subscription?.nickname || '').trim();
    if (!nickname) {
      return;
    }
    const safeNickname = escapeHtml(nickname);
    const letter = safeNickname.charAt(0).toUpperCase() || 'A';
    const avatarUrl = subscription?.avatar_url ? escapeHtml(subscription.avatar_url) : '';

    const item = document.createElement('div');
    item.dataset.subscriptionCard = '';
    item.dataset.authorNickname = safeNickname;
    item.style.cssText = 'display:flex !important; flex-direction:row !important; align-items:center !important; height:48px !important; background:rgba(255,255,255,0.05) !important; margin-bottom:8px !important; padding:0 10px !important; border-radius:10px !important; width:100% !important;';

    const link = document.createElement('a');
    link.href = '#';
    link.dataset.subscriptionCardLink = '';
    link.dataset.authorNickname = safeNickname;
    link.className = 'subscription-card__body';

    const avatarWrapper = document.createElement('span');
    avatarWrapper.className = 'subscription-card__avatar';
    avatarWrapper.style.cssText = 'width:42px !important; height:42px !important; border-radius:50% !important; flex-shrink:0 !important; margin-right:12px !important; overflow:hidden !important;';

    if (avatarUrl) {
      const avatarImg = document.createElement('img');
      avatarImg.src = avatarUrl;
      avatarImg.alt = `Аватар ${safeNickname}`;
      avatarImg.loading = 'lazy';
      avatarImg.style.cssText = 'width:100% !important; height:100% !important; border-radius:50% !important; flex-shrink:0 !important; object-fit:cover !important; margin:0 !important;';
      avatarWrapper.appendChild(avatarImg);
    } else {
      const placeholder = document.createElement('span');
      placeholder.className = 'subscription-card__avatar-placeholder';
      placeholder.setAttribute('aria-hidden', 'true');
      placeholder.textContent = letter;
      avatarWrapper.appendChild(placeholder);
    }

    const info = document.createElement('div');
    info.className = 'subscription-card__info';
    const nicknameSpan = document.createElement('span');
    nicknameSpan.className = 'subscription-card__nickname';
    nicknameSpan.textContent = safeNickname;
    info.appendChild(nicknameSpan);

    link.append(avatarWrapper, info);
    item.appendChild(link);
    fragment.appendChild(item);
  });
  subscriptionsListEl.appendChild(fragment);
}

function applySubscriptionFilters() {
  subscribedAuthorNicknames.clear();
  subscriptions.forEach((subscription) => {
    const normalized = (subscription?.nickname || '').trim().toLowerCase();
    if (normalized) {
      subscribedAuthorNicknames.add(normalized);
    }
  });
  const matchedSubscriptions = activeMarkers.filter(({ pin }) => isPinFromSubscribedAuthor(pin)).length;
  console.debug('[subscriptions] applySubscriptionFilters', { matchedSubscriptions, subscriptionsLoaded: subscriptions.length });
}

function fetchSubscriptions() {
  if (!isAuthenticated()) {
    subscriptions = [];
    renderSubscriptionsList();
    return Promise.resolve();
  }
  return fetch('/api/subscriptions', { credentials: 'same-origin' })
    .then(handleJsonResponse)
    .then((payload) => {
      subscriptions = Array.isArray(payload?.subscriptions) ? payload.subscriptions : [];
      renderSubscriptionsList();
      applySubscriptionFilters();
      refreshAuthorPanelSubscribeButtonState();
      initialSubscriptionsLoaded = true;
    })
    .catch((error) => {
      console.error('Не удалось загрузить подписки', error);
      subscriptions = [];
      renderSubscriptionsList();
      applySubscriptionFilters();
      refreshAuthorPanelSubscribeButtonState();
      initialSubscriptionsLoaded = true;
    });
}

function unsubscribeFromAuthor(nickname) {
  if (!nickname) {
    return;
  }
  const normalized = nickname.trim();
  if (!normalized) {
    return;
  }
  fetch(`/api/subscriptions/${encodeURIComponent(normalized)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
  })
    .then(handleJsonResponse)
    .then(() => {
      showUserToast(`Подписка на ${normalized} отменена.`);
      fetchSubscriptions();
    })
    .catch((error) => {
      showUserToast(error.message || 'Не удалось отменить подписку.');
    });
}

function openAuthorFromSubscription(nickname) {
  const safeNickname = (nickname || '').trim();
  if (!safeNickname) {
    return;
  }
  fetch(`/api/authors/${encodeURIComponent(safeNickname)}`, { credentials: 'same-origin' })
    .then(handleJsonResponse)
    .then((payload) => {
      const author = payload?.author;
      if (!author) {
        throw new Error('Данные автора не найдены.');
      }
      showAuthorPanel(author);
    })
    .catch((error) => {
      showUserToast(error.message || 'Не удалось открыть профиль автора.');
    });
}

function handleActivePinsListClick(event) {
  const title = event.target.closest('[data-active-pin-title]');
  if (title) {
    event.preventDefault();
    const pinId = Number(title.dataset.pinId);
    if (pinId) {
      focusPinFromList(pinId);
    }
    return;
  }
  const deleteBtn = event.target.closest('[data-active-pin-delete]');
  if (deleteBtn) {
    event.preventDefault();
    const pinId = Number(deleteBtn.dataset.pinId);
    if (!pinId) {
      return;
    }
    if (confirm('Удалить метку сейчас? Это действие необратимо.')) {
      handleDeletePin(pinId);
    }
  }
}

function focusPinFromList(pinId) {
  const entry = getActiveMarkerEntry(pinId);
  if (!entry || !entry.pin || !map) {
    return;
  }
  const { pin, marker } = entry;
  map.flyTo([pin.lat, pin.lng], Math.max(map.getZoom(), 14), { animate: true });
  if (marker && typeof marker.openPopup === 'function') {
    marker.openPopup();
  }
}

function startActivePinsClock() {
  stopActivePinsClock();
  activePinsClockId = setInterval(() => {
    renderActivePinsList();
  }, ACTIVE_PINS_CLOCK_INTERVAL);
}

function stopActivePinsClock() {
  if (activePinsClockId) {
    clearInterval(activePinsClockId);
    activePinsClockId = null;
  }
}

function bindActivePinsActions() {
  const listEl = getActivePinsListElement();
  if (!listEl) {
    return;
  }
  listEl.removeEventListener('click', handleActivePinsListClick);
  listEl.addEventListener('click', handleActivePinsListClick);
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

function findBadgeForNickname(nickname) {
  const normalized = (nickname || '').trim();
  if (!normalized) {
    return null;
  }
  const badges = document.querySelectorAll('.pin-popup__author-badge');
  for (const badge of badges) {
    const authorId = (badge.dataset.authorId || '').trim();
    if (authorId && authorId === normalized) {
      return badge;
    }
  }
  return null;
}

function triggerLevelUpAnimation(badgeEl) {
  if (!badgeEl) {
    return;
  }
  badgeEl.classList.add('pin-popup__author-badge--leveled-up');
  setTimeout(() => {
    badgeEl.classList.remove('pin-popup__author-badge--leveled-up');
  }, 2000);
}

function celebrateLevelUpIfNeeded(user) {
  if (!user || levelUpAckedOnce || !user.level_up_pending) {
    return;
  }
  levelUpAckedOnce = true;
  const config = getReputationLevelConfig(user.reputation_level);
  const label = config?.label || 'Новый уровень';
  const icon = config?.icon ? `${config.icon} ` : '';
  showUserToast(`${icon}Поздравляем! Вы достигли уровня ${label}`);
  const badge = findBadgeForNickname(user.nickname || user.user_id || '');
  if (badge) {
    triggerLevelUpAnimation(badge);
  }
  fetch('/api/user/level-up-acknowledged', {
    method: 'POST',
    credentials: 'same-origin',
  })
    .then(handleJsonResponse)
    .then(() => {
      if (currentAuthUser) {
        currentAuthUser.level_up_pending = false;
      }
    })
    .catch((error) => {
      console.warn('level-up-acknowledged endpoint missing or failed:', error?.message || error);
    });
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

function updateGuestUserPanels(authenticated) {
  const userContent = document.querySelector('[data-user-content]');
  const guestContent = document.querySelector('[data-guest-content]');
  if (authenticated) {
    userContent?.classList.remove('is-hidden');
    guestContent?.classList.add('is-hidden');
  } else {
    userContent?.classList.add('is-hidden');
    guestContent?.classList.remove('is-hidden');
  }
}

function toggleUserPanelExpandedState(expanded, view = 'profile') {
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
    panel?.setAttribute('data-panel-visible', view);
  } else {
    chips?.removeAttribute('aria-hidden');
    panel?.removeAttribute('data-panel-visible');
  }
  if (expanded) {
    updateProfileModeButtonVisibility(view);
  } else {
    updateProfileModeButtonVisibility(PROFILE_BUTTON_STATES.COLLAPSED);
  }
}

function updateProfileModeButtonVisibility(mode) {
  const button = document.querySelector('.profile-mode-btn');
  if (!button) {
    return;
  }
  console.log('--- FIX: Profile Button State ---', mode);
  if (mode === PROFILE_BUTTON_STATES.PROFILE) {
    button.style.setProperty('display', 'block', 'important');
  } else {
    button.style.setProperty('display', 'none', 'important');
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
  updateProfileToggleButtonPresence(authenticated);
  const previousAuthenticated = Boolean(renderAuthState.previousAuthenticated);
  const justLoggedIn = authenticated && !previousAuthenticated;
  const nickname = currentAuthUser?.nickname || '';
  const displayNameInput = document.querySelector('.user-panel__input[name="profile_display_name"]');
  const userPanelEl = document.querySelector('.user-panel');
  updateGuestUserPanels(authenticated);
  if (displayNameInput) {
    displayNameInput.value = nickname;
    displayNameInput.disabled = !authenticated;
  }
  if (statusEl) {
    statusEl.textContent = authenticated ? nickname : '';
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
      const userContent = document.querySelector('[data-user-content]');
      if (userContent) {
        userContent.classList.add('is-hidden');
      }
      const guestContent = document.querySelector('[data-guest-content]');
      if (guestContent) {
        guestContent.classList.remove('is-hidden');
      }
      const authPanel = document.getElementById('auth-panel');
      if (authPanel) {
        authPanel.classList.remove('auth-panel--authenticated');
        authPanel.hidden = false;
      }
      setAuthMessage(message);
      const authMessageEl = document.getElementById('auth-message');
      if (authMessageEl) {
        authMessageEl.textContent = message || 'Вы вышли из аккаунта.';
      }
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
  renderActivePinsList();
  bindActivePinsActions();
  if (authenticated) {
    fetchSubscriptions();
    startActivePinsClock();
    if (justLoggedIn) {
      expandFilterPanel();
      toggleUserPanelExpandedState(true);
    }
    celebrateLevelUpIfNeeded(currentAuthUser);
  } else {
    stopActivePinsClock();
  }
  renderAuthState.previousAuthenticated = authenticated;
  syncAuthorCloseButtonLabel();
  updateFollowersCounter(currentAuthUser?.followers_count ?? 0);
}

function updateProfileToggleButtonPresence(authenticated) {
  const slot = document.querySelector('[data-profile-action-slot="toggle-edit"]');
  if (!slot) {
    return;
  }
  const existingButton = slot.querySelector('[data-profile-action="toggle-edit"]');
  if (authenticated) {
    if (existingButton) {
      return;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'profile-mode-btn';
    button.dataset.profileAction = 'toggle-edit';
    button.dataset.profileViewOnly = '';
    button.setAttribute('aria-pressed', 'false');
    button.textContent = 'Редактировать профиль';
    slot.appendChild(button);
    return;
  }
  if (existingButton) {
    existingButton.remove();
  }
}

function initProfileSettings() {
  const profileSection = document.querySelector('.user-panel');
  const profileForm = document.getElementById('profile-form');
  const passwordForm = document.getElementById('password-form');
  const avatarInput = document.getElementById('profile-avatar-input');
  const avatarPreview = document.querySelector('.profile-avatar__image');
  const avatarPlaceholder = avatarPreview?.querySelector('.profile-avatar__placeholder');
  const avatarImg = avatarPreview?.querySelector('img');
  const profileDisplayAvatar = document.getElementById('profile-display-avatar');
  const profileAvatarInitials = document.getElementById('profile-avatar-initials');
  const profileUploadInput = document.getElementById('profile-upload-input');
  const avatarUploadBtn = document.querySelector('[data-profile-action="upload-avatar"]');
  const cancelBtn = document.querySelector('[data-profile-action="cancel"]');
  const saveBtn = document.querySelector('[data-profile-action="save"]');
  const passwordToggleBtn = document.querySelector('[data-password-action="toggle"]');
  const passwordCancelBtn = document.querySelector('[data-password-action="cancel"]');
  const passwordSaveBtn = document.querySelector('[data-password-action="save"]');
  const profileView = profileSection?.querySelector('[data-profile-view]');
  const profileViewNicknameEl = document.getElementById('profile-view-nickname');
  const profileViewAgeEl = document.getElementById('profile-view-age');
  const profileViewGenderEl = document.getElementById('profile-view-gender');
  const profileToggleSlot = profileSection?.querySelector('[data-profile-action-slot="toggle-edit"]');
  const profileSettingsBtn = profileSection?.querySelector('.profile-settings-btn');
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
    if (profileDisplayAvatar) {
      if (url) {
        profileDisplayAvatar.src = url;
        profileDisplayAvatar.hidden = false;
        profileAvatarInitials?.setAttribute('hidden', 'true');
      } else {
        profileDisplayAvatar.hidden = true;
        profileAvatarInitials?.removeAttribute('hidden');
      }
    }
  };

  const getToggleButton = () => profileSection.querySelector('[data-profile-action="toggle-edit"]');

  const reflectProfileState = () => {
     profileSection.dataset.profileMode = profileMode;
    const isEdit = profileMode === 'edit';
     const isView = !isEdit;
    const editToggleBtn = getToggleButton();
    editToggleBtn?.setAttribute('aria-pressed', String(isEdit));
    // we no longer replace button innerHTML to keep icon intact
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

  const friendsSearchPanel = profileSection?.querySelector('.user-panel__friends.search-panel');
  const friendSearchInput = document.getElementById('friend-search-input');
  const friendSearchBtn = document.getElementById('friend-search-btn');
  const friendSearchResults = document.getElementById('search-results');

  const resetFriendSearchMessages = () => {
    if (!friendSearchResults) {
      return;
    }
    friendSearchResults.textContent = '';
    friendSearchResults.classList.add('is-hidden');
    friendSearchResults.classList.remove('search-results--error', 'search-results--success');
  };

  const renderFriendSearchMessage = (message, type = 'info') => {
    if (!friendSearchResults) {
      return;
    }
    friendSearchResults.textContent = message;
    friendSearchResults.classList.remove('search-results--error', 'search-results--success');
    friendSearchResults.classList.toggle('search-results--error', type === 'error');
    friendSearchResults.classList.toggle('search-results--success', type === 'success');
    friendSearchResults.classList.remove('is-hidden');
  };

  const getAuthorByNickname = (nickname) => {
    const safeNickname = (nickname || '').trim();
    if (!safeNickname) {
      return Promise.reject(new Error('Введите никнейм для поиска.'));
    }
    return fetch(`/api/authors/${encodeURIComponent(safeNickname)}`, { credentials: 'same-origin' })
      .then(async (response) => {
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          const errorMessage = payload?.message || 'Не удалось найти автора.';
          throw new Error(errorMessage);
        }
        const payload = await response.json().catch(() => ({}));
        if (!payload?.author) {
          throw new Error('Данные автора не найдены.');
        }
        return payload.author;
      });
  };

  const handleFriendSearch = () => {
    if (!friendSearchInput) {
      return;
    }
    const nickname = friendSearchInput.value.trim();
    resetFriendSearchMessages();
    if (!nickname) {
      renderFriendSearchMessage('Введите никнейм, чтобы найти автора.', 'error');
      friendSearchInput.focus();
      return;
    }
    if (friendSearchBtn) {
      friendSearchBtn.disabled = true;
    }
    getAuthorByNickname(nickname)
      .then((author) => {
        renderFriendSearchMessage(`Панель автора ${author.nickname || nickname} открыта.`, 'success');
        showAuthorPanel(author);
      })
      .catch((error) => {
        renderFriendSearchMessage(error.message || 'Автор не найден.', 'error');
      })
      .finally(() => {
        if (friendSearchBtn) {
          friendSearchBtn.disabled = false;
        }
      });
  };

  const bindFriendSearchHandlers = () => {
    if (friendSearchBtn) {
      friendSearchBtn.addEventListener('click', (event) => {
        event.preventDefault();
        handleFriendSearch();
      });
    }
    if (friendSearchInput) {
      friendSearchInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          handleFriendSearch();
        }
      });
      friendSearchInput.addEventListener('input', () => {
        resetFriendSearchMessages();
      });
    }
  };

    const setProfileMode = (mode) => {
      profileMode = mode;
      const isEdit = mode === 'edit';
      if (friendsSearchPanel) {
        friendsSearchPanel.classList.toggle('is-hidden', isEdit);
      }
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
        const avatarUrl = (payload?.user && payload.user.avatar_url) || payload?.avatar_url;
        if (avatarUrl && profileDisplayAvatar) {
          profileDisplayAvatar.src = avatarUrl;
          profileDisplayAvatar.hidden = false;
          profileAvatarInitials?.setAttribute('hidden', 'true');
        }
      })
      .catch((error) => {
        showToastMessage(error.message || 'Не удалось загрузить аватар.');
      })
      .finally(() => {
        if (avatarInput) {
          avatarInput.value = '';
        }
        if (profileUploadInput) {
          profileUploadInput.value = '';
        }
      });
  };

  profileSettingsBtn?.addEventListener('click', () => {
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

  profileUploadInput?.addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (file) {
      uploadAvatar(file);
    }
  });

  avatarInput?.addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (file) {
      uploadAvatar(file);
    }
  });

    bindFriendSearchHandlers();

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
  attachAuthFormInputFocusHandlers();
}

function attachAuthFormInputFocusHandlers() {
  const { authForm } = getAuthElements();
  if (!authForm) {
    return;
  }
  const inputs = Array.from(authForm.querySelectorAll('input, textarea, select'));
  if (!inputs.length) {
    return;
  }
  // focus handlers intentionally left empty to avoid panel jumps on mobile keyboards
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

function handleCreateSheetSubmit(event) {
  event.preventDefault();
  if (!isAuthenticated()) {
    showUserToast('Нужно войти в аккаунт, чтобы создавать метки.');
    return;
  }
  const titleInput = document.getElementById('create-title-input');
  const descriptionInput = document.getElementById('create-description-input');
  const contactInput = document.getElementById('create-contact-input');
  const submitButton = document.getElementById('create-sheet-submit');
  const selectedCategory = createSheetState?.selectedCategorySlug;
  const selectedSubcategory = createSheetState?.selectedSubcategorySlug;
  const latlng = createSheetState?.latlng;

  const nickname = titleInput?.value?.trim() || '';
  const description = descriptionInput?.value?.trim() || '';
  const contact = contactInput?.value?.trim() || '';

  if (!nickname) {
    alert('Укажите название метки.');
    return;
  }
  if (!selectedCategory) {
    alert('Выберите категорию.');
    return;
  }
  if (!selectedSubcategory) {
    alert('Не удалось определить подкатегорию для выбранной категории.');
    return;
  }
  if (!latlng) {
    alert('Не выбрана точка на карте.');
    return;
  }

  const payload = {
    category: selectedCategory,
    category_slug: selectedCategory,
    subcategory_slug: selectedSubcategory,
    nickname,
    description: description || '',
    contact: contact || null,
    lat: latlng.lat,
    lng: latlng.lng,
  };

  const originalText = submitButton?.textContent;
  if (submitButton) {
    submitButton.disabled = true;
    submitButton.textContent = 'Сохранение...';
  }

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
      closeCreateSheet();
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
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = originalText || 'Создать метку';
      }
    });
}

function createMarkerLabelIcon(pin) {
  const category = getCategoryBySlug(pin.category_slug);
  const categoryColor = category?.color || pin.color || '#ffffff';
  const markerTitle = escapeHtml(pin.title || pin.nickname || 'Метка');

  // Получаем прозрачность на основе оставшегося времени (максимум 0.9, минимум 0.2)
  const opacities = computeOpacityFromTTL(pin.ttl_seconds);
  const currentOpacity = opacities.strokeOpacity;

  const markerHtml = `
    <div class="custom-marker-label" style="--chip-color: ${categoryColor}; opacity: ${currentOpacity};">
      <span class="marker-status-dot" aria-hidden="true"></span>
      <span class="marker-text">${markerTitle}</span>
    </div>
  `;
  return L.divIcon({
    className: 'custom-marker-wrapper',
    html: markerHtml,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
    popupAnchor: [0, -32],
  });
}

function addPinToMap(pin) {
  const marker = L.marker([pin.lat, pin.lng], {
    icon: createMarkerLabelIcon(pin),
    interactive: true,
  });
  marker.pinId = pin.id;
  marker.pinCategorySlug = pin.category_slug;
  marker.pinColor = pin.color;
  marker.pinData = pin;
  const tooltipText = pin.title || pin.nickname || 'Метка';
  marker.bindTooltip(tooltipText, { sticky: true });
  marker.on('click', (event) => {
    L.DomEvent.stopPropagation(event);
    openAuthorSheet(pin);
  });
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
  const subscribedMarkers = activeMarkers.filter(({ pin }) => isPinFromSubscribedAuthor(pin)).length;
  counts.subscriptions = subscribedMarkers;
  const subscribeCountEl = document.querySelector('.subscribe-btn__count');
  if (subscribeCountEl) {
    subscribeCountEl.textContent = String(subscribedMarkers);
  }
  console.debug('[subscriptions] updateCounters', { totalMarkers: activeMarkers.length, subscribedMarkers });
  updateProfileStats(getCurrentUserPins().length);
  renderActivePinsList();
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
      showUserToast('Метка удалена.');
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

function closePinPopupIfOpen(pinId) {
  const entry = getActiveMarkerEntry(pinId);
  if (entry && entry.marker && typeof entry.marker.closePopup === 'function') {
    entry.marker.closePopup();
    return;
  }
  const popupEl = document.querySelector(`.pin-popup[data-pin-id="${pinId}"]`);
  if (popupEl) {
    const popup = popupEl.closest('.leaflet-popup');
    if (popup && popup.parentNode) {
      popup.parentNode.removeChild(popup);
    }
  }
}

function removePinFromMap(pinId) {
  closePinPopupIfOpen(pinId);
  const index = activeMarkers.findIndex(({ marker }) => marker.pinId === pinId);
  if (index !== -1) {
    const { marker } = activeMarkers[index];
    marker.remove();
    activeMarkers.splice(index, 1);
    updateCounters();
  }
}

function applyCategoryFilters() {
  activeMarkers.forEach(({ marker, pin }) => {
    const shouldShow = subscriptionsFilterActive ? isPinFromSubscribedAuthor(pin) : activeCategorySlugs.has(pin.category_slug);
    const isOnMap = map.hasLayer(marker);
    if (shouldShow && !isOnMap) {
      marker.addTo(map);
    } else if (!shouldShow && isOnMap) {
      marker.remove();
    }
  });
}

function isAnyExistingPinPopupOpen() {
  const sheet = document.getElementById('author-sheet');
  if (sheet && !sheet.hasAttribute('hidden') && currentAuthorSheetPinId) {
    return true;
  }
  return activeMarkers.some(({ marker }) => {
    const popup = typeof marker.getPopup === 'function' ? marker.getPopup() : null;
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

  const zoomContainer = map.zoomControl.getContainer();
  if (zoomContainer) {
    const geolocateBtn = document.createElement('button');
    geolocateBtn.type = 'button';
    geolocateBtn.className = 'leaflet-control-zoom-geolocate';
    geolocateBtn.setAttribute('aria-label', 'Центровать на меня');
    geolocateBtn.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 2l7 20-7-6-7 6z" />
      </svg>
    `;
    L.DomEvent.on(geolocateBtn, 'click', L.DomEvent.stopPropagation);
    geolocateBtn.addEventListener('click', (event) => {
      event.preventDefault();
      findUserLocation();
    });
    zoomContainer.appendChild(geolocateBtn);
  }

  const panelHandleContainer = document.querySelector('.panel-handle-container');
  const filterPanel = document.querySelector('.filter-panel');

  const togglePanel = () => {
    if (!filterPanel) {
      return;
    }
    if (filterPanel.classList.contains('collapsed')) {
      expandFilterPanel();
      return;
    }
    if (isMobileViewport()) {
      collapseFilterPanelAnimated();
      return;
    }
    collapseDesktopPanels();
  };

  // --- ЛОГИКА СВАЙПА ДЛЯ ЗАКРЫТИЯ ПАНЕЛИ ---
  const createSheetEl = document.getElementById('create-sheet');
  if (createSheetEl) {
    let startY = 0;
    let currentY = 0;
    let isDraggingSheet = false;

    createSheetEl.addEventListener('touchstart', (e) => {
      if (e.target.closest('.create-sheet__close')) {
        return;
      }
      if (e.target.closest('.create-sheet__drag-handle') || e.target.closest('.create-sheet__header')) {
        startY = e.touches[0].clientY;
        isDraggingSheet = true;
        createSheetEl.style.transition = 'none';
      }
    }, { passive: true });

    createSheetEl.addEventListener('touchmove', (e) => {
      if (!isDraggingSheet) return;
      if (e.cancelable) {
        e.preventDefault();
      }
      currentY = e.touches[0].clientY;
      const deltaY = currentY - startY;
      if (deltaY > 0) {
        createSheetEl.style.transform = `translateY(${deltaY}px)`;
      }
    }, { passive: false });

    createSheetEl.addEventListener('touchend', () => {
      if (!isDraggingSheet) return;
      isDraggingSheet = false;
      const deltaY = currentY - startY;

      createSheetEl.style.transition = 'transform 0.3s cubic-bezier(0.25, 0.8, 0.25, 1)';

      if (deltaY > 80) {
        closeCreateSheet();
      } else {
        createSheetEl.style.transform = 'translateY(0)';
        setTimeout(() => {
          if (createSheetEl.style.transform === 'translateY(0)') {
            createSheetEl.style.transform = '';
            createSheetEl.style.transition = '';
          }
        }, 300);
      }
      startY = 0;
      currentY = 0;
    });
  }

  const authorSheetEl = document.getElementById('author-sheet');
  const authorBackdrop = document.getElementById('author-sheet-backdrop');
  const authorCloseBtn = document.getElementById('author-sheet-close');
  if (authorSheetEl) {
    let startAuthorY = 0;
    let currentAuthorY = 0;
    let isDraggingAuthor = false;

    authorSheetEl.addEventListener('touchstart', (e) => {
      if (e.target.closest('.create-sheet__close')) {
        return;
      }
      if (e.target.closest('.create-sheet__drag-handle') || e.target.closest('.create-sheet__header')) {
        startAuthorY = e.touches[0].clientY;
        currentAuthorY = startAuthorY;
        isDraggingAuthor = true;
        authorSheetEl.style.transition = 'none';
      }
    }, { passive: true });

    authorSheetEl.addEventListener('touchmove', (e) => {
      if (!isDraggingAuthor) return;
      if (e.cancelable) {
        e.preventDefault();
      }
      currentAuthorY = e.touches[0].clientY;
      const deltaY = currentAuthorY - startAuthorY;
      if (deltaY > 0) {
        authorSheetEl.style.transform = `translateY(${deltaY}px)`;
      }
    }, { passive: false });

    authorSheetEl.addEventListener('touchend', () => {
      if (!isDraggingAuthor) return;
      isDraggingAuthor = false;
      const deltaY = currentAuthorY - startAuthorY;

      if (deltaY > 80) {
        authorSheetEl.style.transform = '';
        authorSheetEl.style.transition = '';
        closeAuthorSheet();
      } else {
        authorSheetEl.style.transition = 'transform 0.3s cubic-bezier(0.25, 0.8, 0.25, 1)';
        authorSheetEl.style.transform = 'translateY(0)';
        setTimeout(() => {
          if (!authorSheetEl.hasAttribute('hidden')) {
            authorSheetEl.style.transform = '';
            authorSheetEl.style.transition = '';
          }
        }, 300);
      }
    });

    if (authorCloseBtn) {
      authorCloseBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        closeAuthorSheet();
      });
    }
    if (authorBackdrop) {
      authorBackdrop.addEventListener('click', () => closeAuthorSheet());
    }
  }

  if (panelHandleContainer) {
    panelHandleContainer.addEventListener('click', (event) => {
      if (ignorePanelHandleClick) {
        ignorePanelHandleClick = false;
        event.preventDefault();
        return;
      }
      togglePanel();
    });
    panelHandleContainer.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        togglePanel();
      }
    });
  }

  map.on('click', function (e) {
    if (isAuthorSheetClosing || Date.now() < ignoreMapClicksUntil || Date.now() - lastAuthorSheetClosedAt < 500) {
      return;
    }
    logFilterPanelState('map-click-start', { lat: e?.latlng?.lat, lng: e?.latlng?.lng });
    collapseDesktopPanels();
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

    if (createSheetState.isOpen) {
      createSheetState.latlng = e.latlng;
      return;
    }

    const now = Date.now();
    if (now - lastNonCreationPopupCloseAt < POPUP_REOPEN_GUARD_MS) {
      return;
    }

    openCreateSheet(e.latlng);
  });

let subscribeToggleBtn = document.getElementById('subscribe-toggle-btn');

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
      if (subscriptionsFilterActive) {
        setSubscriptionsMode(false, { silent: true });
      }
      const wasActive = activeCategorySlugs.has(slug);
      if (wasActive) {
        activeCategorySlugs.delete(slug);
      } else {
        activeCategorySlugs.add(slug);
      }
      showAllMode = areAllCategoriesActive() ? SHOW_ALL_MODES.ALL : SHOW_ALL_MODES.OFF;
      updateFiltersUi();
    });
  });

  let subscribeChip = subscribeToggleBtn;
  if (!subscribeChip) {
    const chipContainer = document.querySelector('.category-chips');
    if (chipContainer) {
      subscribeChip = document.createElement('button');
      subscribeChip.id = 'subscribe-toggle-btn';
      subscribeChip.className = 'category-chip subscribe-btn';
      subscribeChip.dataset.subscribeChip = 'true';
      subscribeChip.dataset.categorySlug = 'subscriptions';
      subscribeChip.type = 'button';
      subscribeChip.setAttribute('aria-pressed', 'false');
      subscribeChip.innerHTML = `
        <span class="category-chip__icon" aria-hidden="true">👤</span>
        <span class="category-chip__label">Подписки</span>
        <span class="category-count">0</span>
      `;
      chipContainer.appendChild(subscribeChip);
      categoryChips.push(subscribeChip);
      subscribeToggleBtn = subscribeChip;
    }
  }

  if (subscribeToggleBtn) {
    updateSubscribeButtonState = () => {
      const activeState = subscriptionsFilterActive;
      subscribeToggleBtn.setAttribute('aria-pressed', String(activeState));
      subscribeToggleBtn.classList.toggle('is-active', activeState);
    };

    const handleSubscribeToggleClick = (event) => {
      event.preventDefault();
      const nextState = !subscriptionsFilterActive;
      setSubscriptionsMode(nextState);
      updateSubscribeButtonState();
    };

    updateSubscribeButtonState();
    subscribeToggleBtn.addEventListener('click', handleSubscribeToggleClick);
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

  populateCategoryDropdownPanel();
  attachCategoryDropdownHandlers();

  updateCounters();

  refreshMarkers();
  startAutoRefresh();

  const createSheetForm = document.getElementById('create-sheet-form');
  if (createSheetForm) {
    createSheetForm.addEventListener('submit', handleCreateSheetSubmit);
  }
  const sheetCloseBtn = document.getElementById('create-sheet-close');
  if (sheetCloseBtn) {
    sheetCloseBtn.addEventListener('click', () => closeCreateSheet());
  }
  const sheetBackdrop = document.getElementById('create-sheet-backdrop');
  if (sheetBackdrop) {
    sheetBackdrop.addEventListener('click', () => closeCreateSheet());
  }
});

document.addEventListener('click', function (e) {
  const unsubscribeBtn = e.target.closest('[data-subscribe-action="unsubscribe"]');
  if (unsubscribeBtn) {
    e.preventDefault();
    const nickname = unsubscribeBtn.dataset.authorNickname;
    unsubscribeFromAuthor(nickname);
    return;
  }

  const subscriptionLink = e.target.closest('[data-subscription-card-link]');
  if (subscriptionLink) {
    e.preventDefault();
    const nickname = subscriptionLink.dataset.authorNickname;
    openAuthorFromSubscription(nickname);
    return;
  }
  const voteBtn = e.target.closest('.pin-vote-button');
  if (voteBtn) {
    e.preventDefault();
    const pinId = Number(voteBtn.dataset.pinId);
    if (!pinId || voteInFlightPins.has(pinId)) {
      return;
    }
    const direction = voteBtn.dataset.voteDirection;
    const voteValue = VOTE_DIRECTION_VALUES[direction] || 0;
    const targetValue = currentUserVotes.get(pinId) === voteValue ? 0 : voteValue;
    voteInFlightPins.add(pinId);
    fetch(`/api/pins/${pinId}/vote`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'same-origin',
      body: JSON.stringify({ vote: targetValue }),
    })
      .then(handleJsonResponse)
      .then((payload) => {
        currentUserVotes.set(pinId, targetValue);
        updatePopupRating(pinId, payload.pin_rating);
        const voteButtons = document.querySelector(`.pin-popup__vote-buttons[data-pin-id="${pinId}"]`);
        if (voteButtons) {
          const likesElem = voteButtons.querySelector('[data-pin-likes-count]');
          const dislikesElem = voteButtons.querySelector('[data-pin-dislikes-count]');
          if (likesElem && Number.isFinite(payload.likes_count)) {
            likesElem.textContent = payload.likes_count;
          }
          if (dislikesElem && Number.isFinite(payload.dislikes_count)) {
            dislikesElem.textContent = payload.dislikes_count;
          }
        }
        if (typeof payload.profile_rating !== 'undefined') {
          updateProfileRating(payload.profile_rating);
        }
        refreshPinPopup(pinId);
        const entry = getActiveMarkerEntry(pinId);
        if (entry && entry.pin) {
          entry.pin.rating = Number.isFinite(payload.pin_rating) ? payload.pin_rating : entry.pin.rating;
          entry.pin.likes_count = Number.isFinite(payload.likes_count) ? payload.likes_count : entry.pin.likes_count;
          entry.pin.dislikes_count = Number.isFinite(payload.dislikes_count) ? payload.dislikes_count : entry.pin.dislikes_count;
          entry.pinData = {
            ...entry.pinData,
            rating: entry.pin.rating,
            likes_count: entry.pin.likes_count,
            dislikes_count: entry.pin.dislikes_count,
          };
        }
      })
    .catch((error) => {
      console.error('Vote failed', error);
      showUserToast(error.message || 'Не удалось отправить голос.');
    })
    .finally(() => {
      voteInFlightPins.delete(pinId);
    });
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

document.addEventListener('input', (event) => {
  if (event.target.matches('.pin-comments__form-modern input[name="comment"]')) {
    const form = event.target.closest('.pin-comments__form-modern');
    const btn = form?.querySelector('.comment-send-btn');
    if (btn) {
      btn.disabled = event.target.value.trim().length === 0;
    }
  }
});

document.addEventListener('submit', (event) => {
  const form = event.target.closest('.pin-comments__form-modern');
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
  const form = popup.querySelector('.pin-comments__form-modern');
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
function renderVoteControls(pin) {
  const currentValue = currentUserVotes.get(pin.id) || 0;
  const likes = Number.isFinite(pin.likes_count) ? pin.likes_count : 0;
  const dislikes = Number.isFinite(pin.dislikes_count) ? pin.dislikes_count : 0;
  const upActiveClass = currentValue === 1 ? 'pin-vote-button--active' : '';
  const downActiveClass = currentValue === -1 ? 'pin-vote-button--active' : '';
  return `
    <div class="pin-popup__vote-buttons" data-pin-id="${pin.id}">
      <button type="button" class="pin-vote-button pin-vote-button--up ${upActiveClass}" data-pin-id="${pin.id}" data-vote-direction="up" aria-pressed="${currentValue === 1}" aria-label="Поставить лайк">
        <span class="pin-vote-button__icon" aria-hidden="true">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z"/></svg>
        </span>
        <span class="pin-vote-button__count" data-pin-likes-count>${likes}</span>
      </button>
      <button type="button" class="pin-vote-button pin-vote-button--down ${downActiveClass}" data-pin-id="${pin.id}" data-vote-direction="down" aria-pressed="${currentValue === -1}" aria-label="Поставить дизлайк">
        <span class="pin-vote-button__icon" aria-hidden="true">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M15 3H6c-.83 0-1.54.5-1.84 1.22l-3.02 7.05c-.09.23-.14.47-.14.73v2c0 1.1.9 2 2 2h6.31l-.95 4.57-.03.32c0 .41.17.79.44 1.06L9.83 23l6.59-6.59c.36-.36.58-.86.58-1.41V5c0-1.1-.9-2-2-2zm4 0v12h4V3h-4z"/></svg>
        </span>
        <span class="pin-vote-button__count" data-pin-dislikes-count>${dislikes}</span>
      </button>
    </div>
  `;
}

function populateVoteState(pins) {
  if (!currentAuthUser?.nickname || !Array.isArray(pins)) {
    currentUserVotes.clear();
    return;
  }
  const activeIds = pins.map((pin) => Number(pin.id)).filter(Boolean);
  if (!activeIds.length) {
    currentUserVotes.clear();
    return;
  }
  const params = new URLSearchParams();
  params.set('pins', activeIds.join(','));
  fetch(`/api/user/votes?${params.toString()}`, { credentials: 'same-origin' })
    .then((response) => response.json())
    .then((payload) => {
      const votes = payload?.votes || {};
      currentUserVotes.clear();
      Object.entries(votes).forEach(([pinId, value]) => {
        currentUserVotes.set(Number(pinId), Number(value));
      });
    })
    .catch(() => {
      currentUserVotes.clear();
    });
}

function updatePopupRating(pinId, rating) {
  const ratingElem = document.querySelector(`.pin-popup__rating-value[data-pin-rating-pin="${pinId}"]`);
  if (ratingElem) {
    ratingElem.textContent = Number.isFinite(rating) ? rating : '0';
  }
}

function refreshPinPopup(pinId) {
  const popup = document.querySelector(`.pin-popup[data-pin-id="${pinId}"]`);
  if (!popup) {
    return;
  }
  const voteControls = popup.querySelector('.pin-popup__vote-buttons');
  if (!voteControls) {
    return;
  }
  const likesElem = voteControls.querySelector('[data-pin-likes-count]');
  const dislikesElem = voteControls.querySelector('[data-pin-dislikes-count]');
  const likes = likesElem ? Number(likesElem.textContent.trim()) : 0;
  const dislikes = dislikesElem ? Number(dislikesElem.textContent.trim()) : 0;
  const newMarkup = renderVoteControls({ id: pinId, likes_count: likes, dislikes_count: dislikes });
  voteControls.outerHTML = newMarkup;
}

function updateProfileRating(value) {
  const ratingEl = document.querySelector('[data-profile-rating]');
  if (ratingEl) {
    ratingEl.textContent = Number.isFinite(value) && value !== null ? value : '—';
  }
}
