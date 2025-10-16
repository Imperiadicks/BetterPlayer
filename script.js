/* ФУНКЦИИ ДЛЯ ПОМОЩИ */

/* Асинхронная загрузка изображения для коррекции */
function loadImage(url, { crossOrigin = 'anonymous' } = {}) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        try { img.crossOrigin = crossOrigin; } catch (_) {}
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = url;
    });
}

/* Прелоад изображения перед вставкой фона */
function preloadImage(url) {
    return new Promise((resolve) => {
        const img = new Image();
        // Не ставим crossOrigin тут, фон не рендерится на canvas
        img.onload = () => resolve(true);
        img.onerror = () => resolve(false);
        img.src = url;
    });
}

/* Нормализация и кеш-бастер */
function normalizeUrl(u) {
    return (u || '').toString().replace(/\\/g, '/');
}
function withCacheBust(u) {
    // data:, blob: и about: не трогаем
    if (/^(data:|blob:|about:)/i.test(u)) return u;
    try {
        const url = new URL(u, location.origin);
        url.searchParams.set('cb', Date.now().toString());
        return url.toString();
    } catch {
        // Если это относительный путь без location.origin
        const q = u.includes('?') ? '&' : '?';
        return `${u}${q}cb=${Date.now()}`;
    }
}

/* Получение коррекции яркости, для её нормализации */
async function getBrightnessCorrection(imageUrl, targetBrightness = 0.3) {
    // Загружаем изображение
    const img = await loadImage(imageUrl);

    // Создаем временный canvas
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    // Уменьшаем размер для производительности
    const scale = 100 / Math.max(img.width, img.height);
    canvas.width = img.width * scale;
    canvas.height = img.height * scale;

    // Рисуем изображение
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    // Получаем данные пикселей
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const pixels = imageData.data;

    // Собираем яркости с учетом веса
    const brightnessList = [];
    for (let i = 0; i < pixels.length; i += 4) {
        const x = (i / 4) % canvas.width;
        const y = Math.floor((i / 4) / canvas.width);

        // Вес центральной области
        const dx = x / canvas.width - 0.5;
        const dy = y / canvas.height - 0.5;
        const weight = 1 - Math.sqrt(dx * dx + dy * dy) * 2;

        if (weight > 0) {
            const r = pixels[i];
            const g = pixels[i + 1];
            const b = pixels[i + 2];
            const brightness = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
            brightnessList.push(brightness * weight);
        }
    }

    // Сортируем и берем 90-й перцентиль
    brightnessList.sort((a, b) => a - b);
    const percentile = brightnessList[Math.floor(brightnessList.length * 0.9)] || 0.001;

    // Рассчитываем коэффициент с ограничениями
    let coefficient = targetBrightness / percentile;
    return Math.min(Math.max(coefficient, 0.4), 1);
}

/* Установка фона, яркости, коррекции и блюра — ПЕРЕПИСАНО ДЛЯ ВСТАВКИ НОВОГО ИЗОБРАЖЕНИЯ */
async function setPlayerBackground(settings, image) {
    const autoBlackout = settings.get('autoBlackout');
    const brightness = settings.get('brightness');
    const blur = settings.get('blur');

    const backgroundDiv = document.querySelector('div[data-test-id="FULLSCREEN_PLAYER_MODAL"]');
    if (!backgroundDiv) return;

    const targetUrl = normalizeUrl(image);
    // Если нет картинки — сбрасываем фон
    if (!targetUrl) {
        backgroundDiv.style.setProperty('--background', 'none');
        backgroundDiv.style.removeProperty('--background-next');
        backgroundDiv.removeAttribute('data-bg-url');
        backgroundDiv.classList.remove('animate');
        backgroundDiv.style.setProperty('--brightness-correction', 1);
        return;
    }

    // Если URL тот же — принудительно обновляем через cache-bust,
    // чтобы "вставлялась новая" версия
    const sameLogicalUrl = backgroundDiv.dataset.bgUrl === targetUrl;

    const cssUrl = withCacheBust(targetUrl);

    // Прелоад, чтобы не мигало и не вставляло "пустышку"
    await preloadImage(targetUrl);

    // Если уже идёт анимация — не наслаиваем
    backgroundDiv.classList.remove('animate');
    void backgroundDiv.offsetWidth; // форс-рефлоу

    backgroundDiv.style.setProperty('--background-next', `url("${cssUrl}")`);
    requestAnimationFrame(() => {
        backgroundDiv.classList.add('animate');
    });

    // Надёжное завершение: слушатель + таймаут-фоллбек.
    let done = false;
    const swap = () => {
        if (done) return;
        done = true;
        backgroundDiv.style.setProperty('--background', `url("${cssUrl}")`);
        backgroundDiv.classList.remove('animate');
        backgroundDiv.style.removeProperty('--background-next');
        backgroundDiv.removeEventListener('transitionend', onEnd);
    };
    const onEnd = (e) => { if (e.propertyName === 'opacity') swap(); };
    backgroundDiv.addEventListener('transitionend', onEnd, { once: true });
    setTimeout(swap, 500); 

    // Фиксируем "логический" URL без кеш-бастера, чтобы сравнивать смену трека
    if (!sameLogicalUrl) backgroundDiv.dataset.bgUrl = targetUrl;

    // Коррекция яркости только для реальных внешних URL
    if (autoBlackout?.value && targetUrl) {
        // Для коррекции можно взять уменьшенную версию, если это обложка ЯМ
        // иначе берём как есть
        const sourceForCorrection = (/\/%%\//.test(targetUrl) || targetUrl.includes('%%'))
            ? normalizeUrl(targetUrl.replace('%%', '100x100'))
            : targetUrl;

        getBrightnessCorrection(sourceForCorrection)
            .then((correction) => {
                backgroundDiv.style.setProperty('--brightness-correction', correction);
            })
            .catch(() => {
                backgroundDiv.style.setProperty('--brightness-correction', 1);
            });
    } else {
        backgroundDiv.style.setProperty('--brightness-correction', 1);
    }

    if (brightness?.value !== undefined) {
        backgroundDiv.style.setProperty(
            '--brightness',
            (brightness.value != undefined) ? (brightness.value / 100) : (brightness.default / 100)
        );
    }

    if (blur?.value != undefined) {
        backgroundDiv.style.setProperty('--blur', `${blur.value ?? blur.default}px`);
    }
}

/* Установка "Улучшенного плеера" */
let controlsParents = {}

// === ПОЛНАЯ ЗАМЕНА ФУНКЦИИ ===
function setupBetterPlayer(settings, styles) {
    const setting = settings.get('betterPlayer');
    let customControls = document.querySelector('.customPlayerControls');

    const controls = document.querySelector('.FullscreenPlayerDesktopControls_sonataControls__9AIki');
    const contextMenu = document.querySelector('.FullscreenPlayerDesktopControls_menuButton__R4cXl[data-test-id="FULLSCREEN_PLAYER_CONTEXT_MENU_BUTTON"]');
    const likeButton = document.querySelector('.FullscreenPlayerDesktopControls_likeButton__vpJ7S[data-test-id="LIKE_BUTTON"]');
    const playQueueButton = document.querySelector('.FullscreenPlayerDesktopControls_playQueueButton__reNOW[data-test-id="FULLSCREEN_PLAYER_QUEUE_BUTTON"]');

    if (!setting) return;
    if (!setting.value) {
        if (customControls) {
            if (typeof controlsParents !== 'undefined') {
                if (controlsParents.playQueueButton) controlsParents.playQueueButton.appendChild(playQueueButton);
                if (controlsParents.controls) controlsParents.controls.appendChild(controls);
                if (controlsParents.contextMenu) controlsParents.contextMenu.appendChild(contextMenu);
                if (controlsParents.likeButton) controlsParents.likeButton.appendChild(likeButton);
            }
            customControls.remove();
        }
        styles.remove('betterPlayer');
        styles.remove('playerButtonsBackground');
        styles.remove('playerButtonsInvertBackground');
        return;
    }

    const sonataState = document.querySelector('.FullscreenPlayerDesktopContent_info__Dq69p');
    const timecode = sonataState?.querySelector('div[data-test-id="TIMECODE_WRAPPER"]');
    if (timecode) timecode.classList.remove('ChangeTimecode_root_fullscreen__FA6r0');

    if (!customControls) {
        if (!controls) return;

        // запомним родителей, как у тебя
        if (typeof controlsParents === 'undefined') window.controlsParents = {};
        controlsParents = {
            'controls': controls.parentElement,
            'contextMenu': contextMenu.parentElement,
            'likeButton': likeButton.parentElement,
            'playQueueButton': playQueueButton.parentElement
        };

        // контейнер
        customControls = document.createElement('div');
        customControls.classList.add('customPlayerControls');
        customControls.append(playQueueButton, contextMenu, controls, likeButton);

        // наша кастомная кнопка
        const newCustomLyricsButton = document.createElement('button');
        newCustomLyricsButton.classList.add(
            'custom-text','cpeagBA1_PblpJn8Xgtv','iJVAJMgccD4vj4E4o068','zIMibMuH7wcqUoW7KH1B',
            'IlG7b1K0AD7E7AMx6F5p','nHWc2sto1C6Gm0Dpw_l0','SGYcNjvjmMsXeEVGUV2Z','qU2apWBO1yyEK0lZ3lPO',
            'FullscreenPlayerDesktopControls_syncLyricsButton__g6E6g'
        );
        newCustomLyricsButton.innerHTML =
            '<span class="JjlbHZ4FaP9EAcR_1DxF"><svg class="J9wTKytjOWG73QMoN5WP o_v2ds2BaqtzAsRuCVjw"><use xlink:href="icons/sprite.svg#syncLyrics_xs"></use></svg></span>';
        // важно: другой data-test-id, чтобы не путать с оригиналами
        newCustomLyricsButton.setAttribute('data-test-id','PLAYERBAR_DESKTOP_SYNC_LYRICS_BUTTON_CLONE');

        // helpers
        const qsAll = (sel) => Array.from(document.querySelectorAll(sel));
        const raf = (cb) => (window.requestAnimationFrame ? requestAnimationFrame(cb) : setTimeout(cb, 0));

        let openBtn = null;   // нижняя (открывает)
        let toggleBtn = null; // fullscreen (умеет закрывать)
        let openObs = null, toggleObs = null;

        const selectOriginals = () =>
            qsAll('button[data-test-id="PLAYERBAR_DESKTOP_SYNC_LYRICS_BUTTON"]:not(.custom-text):not([data-test-id="PLAYERBAR_DESKTOP_SYNC_LYRICS_BUTTON_CLONE"])');

        function updateButtonRefs() {
            const all = selectOriginals();
            openBtn   = all.find(el => !el.className.includes('FullscreenPlayerDesktopControls_syncLyricsButton')) || null;
            toggleBtn = all.find(el =>  el.className.includes('FullscreenPlayerDesktopControls_syncLyricsButton')) || null;
        }
        function canUse(btn) {
            return !!btn && !btn.disabled &&
                   btn.getAttribute('aria-busy') !== 'true' &&
                   btn.getAttribute('aria-hidden') !== 'true';
        }
        function isActiveByBtn(btn) {
            if (!btn) return false;
            if (btn.getAttribute('aria-pressed') === 'true') return true;
            const svg = btn.querySelector('svg');
            return !!svg && svg.classList.contains('SyncLyricsButton_icon_active__6WcWG');
        }
        function isLyricsOpen() {
            return toggleBtn ? isActiveByBtn(toggleBtn) : isActiveByBtn(openBtn);
        }

        function bindWatchers() {
            if (openObs)   openObs.disconnect();
            if (toggleObs) toggleObs.disconnect();

            if (openBtn) {
                openObs = new MutationObserver(syncState);
                openObs.observe(openBtn, { attributes: true, attributeFilter: ['class','disabled','aria-busy','aria-hidden','aria-pressed'] });
            }
            if (toggleBtn) {
                toggleObs = new MutationObserver(syncState);
                toggleObs.observe(toggleBtn, { attributes: true, attributeFilter: ['class','disabled','aria-busy','aria-hidden','aria-pressed'] });
            }
        }

        function syncState() {
            updateButtonRefs();
            const usable = canUse(openBtn) || canUse(toggleBtn);
            const active = isLyricsOpen();

            newCustomLyricsButton.disabled = !usable;
            const svg = newCustomLyricsButton.querySelector('svg');
            if (svg) svg.classList.toggle('SyncLyricsButton_icon_active__6WcWG', !!active);
        }

        newCustomLyricsButton.onclick = () => {
            updateButtonRefs();
            const opened = isLyricsOpen();

            if (opened) {
                if (canUse(toggleBtn)) toggleBtn.click();      // закрыть
            } else {
                if (canUse(openBtn))   openBtn.click();        // открыть приоритетно нижней
                else if (canUse(toggleBtn)) toggleBtn.click(); // fallback
            }
            raf(syncState);
        };

        // реагируем на перерисовку fullscreen из твоей библиотеки
        if (window.Theme?.sonataState?.on) {
            window.Theme.sonataState.on('playerDomChange', () => {
                updateButtonRefs();
                bindWatchers();
                syncState();
            });
        }

        // подстраховка — общий наблюдатель за DOM
        const bodyObserver = new MutationObserver(() => {
            const oldToggle = toggleBtn;
            updateButtonRefs();
            if (oldToggle !== toggleBtn) {
                bindWatchers();
                syncState();
            }
        });
        bodyObserver.observe(document.body, { childList: true, subtree: true });

        // init
        updateButtonRefs();
        bindWatchers();
        syncState();

        customControls.appendChild(newCustomLyricsButton);
        sonataState.appendChild(customControls);

       styles.add('betterPlayer', `
            .customPlayerControls {
                display: flex;
                justify-content: center;
                align-items: center;
            }
            
            div[data-test-id="FULLSCREEN_PLAYER_POSTER_CONTENT"] {
                display: none;
            }
    
            .SonataFullscreenControlsDesktop_sonataButton__qmSTF,
            .SonataFullscreenControlsDesktop_sonataButton__qmSTF:disabled,
            .FullscreenPlayerDesktopControls_menuButton__R4cXl,
            .FullscreenPlayerDesktopControls_likeButton__vpJ7S,
            .FullscreenPlayerDesktopControls_playQueueButton__reNOW,
            .FullscreenPlayerDesktopControls_syncLyricsButton__g6E6g {
                background: transparent;
            }
            
            .SonataFullscreenControlsDesktop_sonатаButton__qmSTF:not(:disabled):focus-visible,
            .SonataFullscreenControlsDesktop_sonатаButton__qmSTF:not(:disabled):hover,
            .FullscreenPlayerDesktopControls_menuButton__R4cXl:not(:disabled):focus-visible,
            .FullscreenPlayerDesktopControls_menuButton__R4cXl:not(:disabled):hover,
            .FullscreenPlayerDesktopControls_menuButton_active__YZ8M8,
            .FullscreenPlayerDesktopControls_likeButton__vpJ7S:not(:disabled):focus-visible,
            .FullscreenPlayerDesktopControls_likeButton__vpJ7S:not(:disabled):hover,
            .FullscreenPlayerDesktopControls_playQueueButton__reNOW:not(:disabled):focus-visible,
            .FullscreenPlayerDesktopControls_playQueueButton__reNOW:not(:disabled):hover,
            .FullscreenPlayerDesktopControls_syncLyricsButton__g6E6g:not(:disabled):focus-visible,
            .FullscreenPlayerDesktopControls_syncLyricsButton__g6E6g:not(:disabled):hover {
                background: transparent;
            }
    
            .SonataFullscreenControlsDesktop_sonataButton__qmSTF[data-test-id="PLAY_BUTTON"],
            .SonataFullscreenControlsDesktop_sonataButton__qmSTF[data-test-id="PAUSE_BUTTON"] {
                border-style: solid;
                border-width: 3px;
                border-color: var(--ym-controls-color-secondary-text-enabled_variant);
            }
    
            .SonataFullscreenControlsDesktop_buttonContainer__mkxBw {
                min-width: fit-content;
            }
    
            .SonataFullscreenControlsDesktop_root__l4a2W {
                gap: 0;
            }
    
            .SonataFullscreenControlsDesktop_sonataButtons__BNse_ {
                gap: 4px;
                transform: scale(0.8);
            }
    
            .FullscreenPlayerDesktopControls_likeButton__vpJ7S svg,
            .FullscreenPlayerDesktopControls_menuButton__R4cXl svg,
            .FullscreenPlayerDesktopControls_playQueueButton__reNOW svg,
            .FullscreenPlayerDesktopControls_syncLyricsButton__g6E6g svg {
                height: 28px;
                width: 28px;
            }
                
            .FullscreenPlayerDesktopControls_playQueueButton__reNOW,
            .FullscreenPlayerDesktopControls_syncLyricsButton__g6E6g {
                margin-inline-end: 0;
                margin-block-end: 0;
                margin-block-start: 0;
                align-self: auto;
            }
    
            .ChangeTimecode_slider__P4qmT {
                --slider-thumb-box-shadow-color: transparent;
            }
    
            .FullscreenPlayerDesktopContent_fullscreenContent_enter__xMN2Y,
            .FullscreenPlayerDesktopContent_fullscreenContent_leave__6HeZ_ {
                animation-name: none;
            }
    
            .FullscreenPlayerDesktopContent_additionalContent__tuuy7 {
                transform: translate(50%);
                height: calc(100% - (var(--fullscreen-player-content-size-px)/2) - 8px - 32px);
                top: 32px;
            }
            
            .FullscreenPlayerDesktopContent_syncLyrics__6dTfH,
            .PlayQueue_root__ponhw {
                height: 100%;
            }
    
            .FullscreenPlayerDesktopContent_fullscreenContent__Nvety {
                transform: translate(calc(50dvw - var(--fullscreen-player-content-size-px)/2),calc(100dvh - var(--fullscreen-player-height-px)/2 + 32px));
            }
    
            .FullscreenPlayerDesktopContent_additionalContent_enter_active__a3nOf {
                animation-name: FullscreenPlayerDesktopContent_enter-fade-additional-content_custom;
            }
            
            .FullscreenPlayerDesktopContent_additionalContent_exit_active__vokVE {
                animation-name: FullscreenPlayerDesktopContent_leave-fade-additional-content_custom;
            }
    
            .custom-text {
                color: var(--ym-controls-color-secondary-text-enabled);
                transition: color 0.3s ease;
            }
    
/*             .custom-text svg {
                padding: 3px 2px 4px 2px;
            } */
    
            .custom-text use:not(svg) {
                transform-origin: 0px 0px;
            }
    
            .custom-text[disabled] {
                color: var(--ym-controls-color-secondary-text-disabled);
                background: transparent;
            }
    
            @keyframes FullscreenPlayerDesktopContent_enter-fade-additional-content_custom {
                0% {
                    transform: translate(0dvw);
                    opacity: 0
                }
    
                50% {
                    transform: translate(26dvw);
                }
    
                to {
                    transform: translate(25dvw);
                    opacity: 1
                }
            }
    
            @keyframes FullscreenPlayerDesktopContent_leave-fade-additional-content_custom {
                0% {
                    transform: translate(25dvw);
                    opacity: 1
                }
    
                40% {
                    opacity: 0
                }
    
                to {
                    transform: translate(0dvw);
                    opacity: 0
                }
            }
    
            .ChangeTimecode_root_fullscreen__FA6r0 {
                grid-template: initial !important;
                column-gap: initial !important;
                row-gap: initial !important;
            }
    
            .FullscreenPlayerDesktopContent_meta__3jDTy {
                padding: 0;
            }
    
            .FullscreenPlayerDesktopContent_info__Dq69p {
                height: fit-content;
                width: fit-content;
            }
        `);
    }

    // фон/инверт — как у тебя
    const playerButtonsBackground = settings.get('playerButtonsBackground');
    const playerButtonsInvertBackground = settings.get('playerButtonsInvertBackground');
    if (playerButtonsBackground.value) {
        styles.add('playerButtonsBackground', `
            .FullscreenPlayerDesktopContent_syncLyrics__6dTfH,
            .FullscreenPlayerDesktopContent_info__Dq69p,
            .PlayQueue_root__ponhw {
                padding:16px; background-color:rgba(0,0,0,.35); backdrop-filter:blur(15px); border-radius:16px;
            }
        `);
        if (playerButtonsInvertBackground.value) {
            styles.add('playerButtonsInvertBackground', `
                .FullscreenPlayerDesktopContent_syncLyrics__6dTfH,
                .FullscreenPlayerDesktopContent_info__Dq69p,
                .PlayQueue_root__ponhw { backdrop-filter:invert(1) blur(15px); }
            `);
        } else styles.remove('playerButtonsInvertBackground');
    } else {
        styles.remove('playerButtonsBackground');
        styles.remove('playerButtonsInvertBackground');
    }
}






/* НАЧАЛО ТЕМЫ */
const betterPlayer = new Theme('BetterPlayer');

betterPlayer.sonataState.on('openPlayer', ({ settings, styles, state }) => {
    const setting = settings.get('playerBackground');
    const backgroundImage = settings.get('backgroundImage');
    if (!setting) return;

    const image = setting.value
        ? 'https://' + state.track.coverUri.replace('%%', '1000x1000')
        : normalizeUrl(backgroundImage.value);

    setPlayerBackground(settings, image);
    setupBetterPlayer(settings, styles);
});

betterPlayer.sonataState.on('trackChange', ({ settings, state }) => {
    const customLyricsButton = document.querySelector('.customPlayerControls .custom-text');

    const all = Array.from(document.querySelectorAll(
        'button[data-test-id="PLAYERBAR_DESKTOP_SYNC_LYRICS_BUTTON"]:not(.custom-text):not([data-test-id="PLAYERBAR_DESKTOP_SYNC_LYRICS_BUTTON_CLONE"])'
    ));
    const openBtn   = all.find(el => !el.className.includes('FullscreenPlayerDesktopControls_syncLyricsButton'));
    const toggleBtn = all.find(el =>  el.className.includes('FullscreenPlayerDesktopControls_syncLyricsButton'));

    const canUse = (btn) => !!btn && !btn.disabled &&
        btn.getAttribute('aria-busy') !== 'true' &&
        btn.getAttribute('aria-hidden') !== 'true';

    const isActive = (btn) => {
        if (!btn) return false;
        if (btn.getAttribute('aria-pressed') === 'true') return true;
        const svg = btn.querySelector('svg');
        return !!svg && svg.classList.contains('SyncLyricsButton_icon_active__6WcWG');
    };

    // обновим состояние кастомной
    if (customLyricsButton) {
        const svg = customLyricsButton.querySelector('svg');
        const active = toggleBtn ? isActive(toggleBtn) : isActive(openBtn);
        if (svg) svg.classList.toggle('SyncLyricsButton_icon_active__6WcWG', !!active);
        customLyricsButton.disabled = !(canUse(openBtn) || canUse(toggleBtn));
    }
});

// Навсякий, чтобы не баговалось
betterPlayer.sonataState.on('openText', () => {
    const customLyricsButton = document.querySelector('.custom-text');
    if (customLyricsButton) customLyricsButton.querySelector('svg').classList.add('SyncLyricsButton_icon_active__6WcWG');
})
betterPlayer.sonataState.on('closeText', () => {
    const customLyricsButton = document.querySelector('.custom-text');
    if (customLyricsButton) customLyricsButton.querySelector('svg').classList.remove('SyncLyricsButton_icon_active__6WcWG');
})

betterPlayer.settingsManager.on('change:playerBackground', ({ settings, state }) => {
    const playerBackground = settings.get('playerBackground');
    const backgroundImage = settings.get('backgroundImage');

    if (!playerBackground) return;

    const image = playerBackground.value
        ? 'https://' + state.track.coverUri.replace('%%', '1000x1000')
        : normalizeUrl(backgroundImage.value);

    setPlayerBackground(settings, image);
});

betterPlayer.settingsManager.on('change:backgroundImage', ({ settings }) => {
    const playerBackground = settings.get('playerBackground');
    const backgroundImage = settings.get('backgroundImage');
    if (playerBackground.value) return;

    const image = normalizeUrl(backgroundImage.value);
    setPlayerBackground(settings, image);
});

betterPlayer.settingsManager.on('change:autoBlackout', async ({ settings, state }) => {
    const autoBlackout = settings.get('autoBlackout');
    const playerBackground = settings.get('playerBackground');
    if (!autoBlackout) return;

    const backgroundDiv = document.querySelector('div[data-test-id="FULLSCREEN_PLAYER_MODAL"]');
    if (!backgroundDiv) return;
    if (!autoBlackout.value || !playerBackground.value) return backgroundDiv.style.setProperty('--brightness-correction', 1);

    const image = 'https://' + state.track.coverUri.replace('%%', '100x100');
    if (!image) return;

    getBrightnessCorrection(image)
        .then(correction => {
            backgroundDiv.style.setProperty('--brightness-correction', correction);
        })
        .catch(() => {
            backgroundDiv.style.setProperty('--brightness-correction', 1);
        });
});

betterPlayer.settingsManager.on('change:brightness', ({ settings }) => {
    const brightness = settings.get('brightness');
    if (!brightness) return;

    const backgroundDiv = document.querySelector('div[data-test-id="FULLSCREEN_PLAYER_MODAL"]');
    if (!backgroundDiv) return;
    backgroundDiv.style.setProperty('--brightness', (brightness.value != undefined) ? (brightness.value / 100) : (brightness.default / 100));
});

betterPlayer.settingsManager.on('change:blur', ({ settings }) => {
    const blur = settings.get('blur');
    if (!blur) return;

    const backgroundDiv = document.querySelector('div[data-test-id="FULLSCREEN_PLAYER_MODAL"]');
    if (!backgroundDiv) return;
    backgroundDiv.style.setProperty('--blur', blur.value != undefined ? `${blur.value}px` : `${blur.default}px`);
});

betterPlayer.settingsManager.on('change:betterPlayer', ({ settings, styles }) => {
    setupBetterPlayer(settings, styles);
});

betterPlayer.settingsManager.on('change:playerButtonsBackground', ({ settings, styles }) => {
    const betterPlayer = settings.get('betterPlayer');
    if (!betterPlayer) return;
    if (!betterPlayer.value)  return;
    
    const playerButtonsBackground = settings.get('playerButtonsBackground');
    const playerButtonsInvertBackground = settings.get('playerButtonsInvertBackground');

    if (playerButtonsBackground.value) {
        styles.add('playerButtonsBackground', `
            .FullscreenPlayerDesktopContent_syncLyrics__6dTfH,
            .FullscreenPlayerDesktopContent_info__Dq69p,
            .PlayQueue_root__ponhw {
                padding: 16px;
                background-color: rgba(0, 0, 0, 0.35);
                backdrop-filter: blur(15px);
                border-radius: 16px;
            }
        `);
        if (playerButtonsInvertBackground.value) {
            styles.add('playerButtonsInvertBackground', `
                .FullscreenPlayerDesktopContent_syncLyrics__6dTfH,
                .FullscreenPlayerDesktopContent_info__Dq69p,
                .PlayQueue_root__ponhw {
                    backdrop-filter: invert(1) blur(15px);
                }
            `);
        }
    } else {
        styles.remove('playerButtonsBackground');
        styles.remove('playerButtonsInvertBackground');
    }
});

betterPlayer.settingsManager.on('change:playerButtonsInvertBackground', ({ settings, styles }) => {
    const betterPlayer = settings.get('betterPlayer');
    if (!betterPlayer) return;
    if (!betterPlayer.value)  return;
    
    const playerButtonsBackground = settings.get('playerButtonsBackground');
    if (!playerButtonsBackground.value) return;
    
    const playerButtonsInvertBackground = settings.get('playerButtonsInvertBackground');
    if (playerButtonsInvertBackground.value) {
        styles.add('playerButtonsInvertBackground', `
            .FullscreenPlayerDesktopContent_syncLyrics__6dTfH,
            .FullscreenPlayerDesktopContent_info__Dq69p,
            .PlayQueue_root__ponhw {
                backdrop-filter: invert(1) blur(15px);
            }
        `);
    } else {
        styles.remove('playerButtonsInvertBackground');
    }
});

betterPlayer.start(1000);
