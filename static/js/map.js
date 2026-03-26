const bootstrapScript = document.getElementById('live-map-bootstrap');
const bootstrapData = bootstrapScript ? JSON.parse(bootstrapScript.textContent) : {};
const defaults = bootstrapData.defaults || { lat: 55.75, lng: 37.61, zoom: 13 };
const categoriesScript = document.getElementById('category-definitions');
const categoriesData = categoriesScript ? JSON.parse(categoriesScript.textContent) : [];
const activeMarkers = [];
const activeCategorySlugs = new Set();
const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
const allCategorySlugs = categoriesData.map((group) => group.slug).filter(Boolean);
const LIVE_MAP_USER_ID_STORAGE_KEY = 'liveMapUserId';
const SHOW_ALL_MODES = { ALL: 'all', OFF: 'off' };
const AUTO_REFRESH_INTERVAL = 60_000;
const USER_MARKER_LIMIT = 5;
const baseStrokeOpacity = 0.9;
const baseFillOpacity = 0.6;
const MOBILE_BREAKPOINT_PX = 768;
const USER_LIMIT_MESSAGE = 'Вы достигли лимита в 5 меток. Пожалуйста, удалите старую или дождитесь её исчезновения.';
const POPUP_REOPEN_GUARD_MS = 200;

window.currentCreationMarker = null;
window.userLocationMarker = null;
let userLocationIcon = null;
let map;
let creationSelection = getDefaultCreationSelection();
let touchStartY = null;
let showAllMode = SHOW_ALL_MODES.OFF;
let showAllBtn = null;
let refreshBtn = null;
let autoRefreshTimerId = null;
let categoryChips = [];
let userToastTimeoutId = null;
let lastNonCreationPopupCloseAt = 0;
let filterPanelElement = null;

function isMobileViewport() {
  return window.innerWidth < MOBILE_BREAKPOINT_PX;
}

function minimizeFilterPanelForCreation() {
  if (!filterPanelElement || !isMobileViewport()) {
    return;
  }
  filterPanelElement.classList.add('minimized');
}

function restoreFilterPanelAfterCreation() {
  if (!filterPanelElement) {
    return;
  }
  filterPanelElement.classList.remove('minimized');
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

function setShowAllMode(mode) {
  if (!Object.values(SHOW_ALL_MODES).includes(mode)) {
    return;
  }
  if (showAllMode === mode) {
    return;
  }
  showAllMode = mode;
  updateShowAllButtonAppearance();
  if (showAllMode === SHOW_ALL_MODES.ALL) {
    activateAllCategories();
  } else {
    deactivateAllCategories();
  }
  syncShowAllMode();
}

function updateShowAllButtonAppearance() {
  if (!showAllBtn) {
    return;
  }
  const isActive = showAllMode === SHOW_ALL_MODES.ALL;
  showAllBtn.classList.toggle('show-all-btn--active', isActive);
  showAllBtn.classList.toggle('show-all-btn--off', !isActive);
  showAllBtn.setAttribute('aria-pressed', String(isActive));
  const icon = showAllBtn.querySelector('.show-all-btn__icon');
  if (icon) {
    icon.textContent = isActive ? 'ALL' : 'OFF';
  }
}

function syncShowAllMode() {
  applyCategoryFilters();
}

function activateAllCategories() {
  if (!categoryChips.length) {
    return;
  }
  activeCategorySlugs.clear();
  allCategorySlugs.forEach((slug) => activeCategorySlugs.add(slug));
  categoryChips.forEach((chip) => {
    chip.classList.add('is-active');
    chip.setAttribute('aria-pressed', 'true');
  });
}

function deactivateAllCategories() {
  if (!categoryChips.length) {
    return;
  }
  activeCategorySlugs.clear();
  categoryChips.forEach((chip) => {
    chip.classList.remove('is-active');
    chip.setAttribute('aria-pressed', 'false');
  });
}

function fetchPins() {
  return fetch('/api/pins')
    .then((response) => response.json())
    .then((pins) => {
      clearMarkers();
      pins.forEach((pin) => {
        const slug = pin.category_slug || pin.category;
        pin.color = colorForCategorySlug(slug);
        addPinToMap(pin);
      });
      applyCategoryFilters();
      updateCounters();
    })
    .catch((error) => {
      console.error('Failed to load pins', error);
    });
}

function refreshMarkers() {
  if (refreshBtn) {
    refreshBtn.disabled = true;
    refreshBtn.classList.add('refresh-btn--loading');
  }
  return fetchPins().finally(() => {
    if (refreshBtn) {
      refreshBtn.disabled = false;
      refreshBtn.classList.remove('refresh-btn--loading');
    }
  });
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

function createPopupContent(pin) {
  const category = getCategoryBySlug(pin.category_slug);
  const currentUserId = getOrCreateLiveMapUserId();
  const isAuthor = Boolean(currentUserId && pin.user_id && currentUserId === pin.user_id);
  const deleteButton = isAuthor
    ? `<button class="delete-pin delete-pin-btn" data-pin-id="${pin.id}">Удалить</button>`
    : '';
  const shareUrl = new URL(`/pin/${pin.shared_token}`, window.location.origin).href;
  return `
    <div class="pin-popup">
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
    </div>
  `;
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

  const panel = document.querySelector('.filter-panel')
    || document.querySelector('header')
    || document.getElementById('filter-panel');
  if (panel) {
    panel.classList.add('minimized');
    console.log('Панель найдена и класс добавлен');
  } else {
    alert('Критическая ошибка: Панель фильтров не найдена в коде!');
  }

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
  marker
    .bindPopup(getCreationPopupContent(latlng), {
      closeOnClick: false,
      autoPan: true,
      keepInView: true,
      autoPanPaddingTopLeft: L.point(12, 12),
      autoPanPaddingBottomRight: L.point(12, 12),
    })
    .openPopup();
  marker.on('popupopen', (event) => {
    applyPopupFadeEffect(event.popup);
    minimizeFilterPanelForCreation();
  });
  marker.on('popupclose', () => {
    clearCreationMarker();
    restoreFilterPanelAfterCreation();
  });
  return marker;
}

function clearCreationMarker() {
  const panel = document.querySelector('.filter-panel')
    || document.querySelector('header')
    || document.getElementById('filter-panel');
  if (panel) {
    panel.classList.remove('minimized');
  }

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
  const currentUserId = getOrCreateLiveMapUserId();
  if (!currentUserId) {
    return 0;
  }
  return activeMarkers.reduce((count, { pin }) => (pin.user_id === currentUserId ? count + 1 : count), 0);
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
    liveMapUserId: getOrCreateLiveMapUserId(),
  };
  saveBtn.disabled = true;
  fetch('/api/pins', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
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
  const payload = {
    liveMapUserId: getOrCreateLiveMapUserId(),
  };
  fetch(`/api/pins/${pinId}`, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
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
    const shouldShow = showAllMode === SHOW_ALL_MODES.ALL || activeCategorySlugs.has(pin.category_slug);
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
    filterPanel.classList.toggle('collapsed');
  };

  const handleTouchEnd = (e) => {
    if (!touchStartY) {
      return;
    }
    const deltaY = e.changedTouches[0].clientY - touchStartY;
    const threshold = 15;
    if (deltaY > threshold) {
      filterPanel.classList.add('collapsed');
      restoreFilterPanelAfterCreation();
    } else if (deltaY < -threshold) {
      filterPanel.classList.remove('collapsed');
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
    if (window.currentCreationMarker) {
      clearCreationMarker();
      restoreFilterPanelAfterCreation();
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
    chip.classList.remove('is-active');
    chip.setAttribute('aria-pressed', 'false');
    chip.addEventListener('click', () => {
      const slug = chip.dataset.categorySlug;
      if (!slug) {
        return;
      }
      const isActive = chip.classList.toggle('is-active');
      chip.setAttribute('aria-pressed', String(isActive));
      if (isActive) {
        activeCategorySlugs.add(slug);
      } else {
        activeCategorySlugs.delete(slug);
      }
      applyCategoryFilters();
    });
  });

  resetBtn.addEventListener('click', () => {
    if (activeCategorySlugs.size === 0) {
      return;
    }
    activeCategorySlugs.clear();
    categoryChips.forEach((chip) => {
      chip.classList.remove('is-active');
      chip.setAttribute('aria-pressed', 'false');
    });
    applyCategoryFilters();
  });

  showAllBtn = document.getElementById('show-all-btn');
  if (showAllBtn) {
    showAllBtn.addEventListener('click', (event) => {
      event.preventDefault();
      const nextMode = showAllMode === SHOW_ALL_MODES.ALL ? SHOW_ALL_MODES.OFF : SHOW_ALL_MODES.ALL;
      setShowAllMode(nextMode);
    });
    updateShowAllButtonAppearance();
  }

  refreshBtn = document.getElementById('refresh-btn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      refreshMarkers();
    });
  }

  filterPanelElement = document.querySelector('.filter-panel');

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
});
