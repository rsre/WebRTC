/** Chrome 63+, Safari 11.1+ */
import {VideoRTC} from './video-rtc-mike.js?v=1.9.12-mike.2';
import {DigitalPTZ} from './digital-ptz.js?v=3.3.0';

class WebRTCCamera extends VideoRTC {
    /**
     * Step 1. Called by the Hass, when config changed.
     * @param {Object} config
     */
    setConfig(config) {
        if (!config.url && !config.entity && !config.streams) throw new Error('Missing `url` or `entity` or `streams`');

        if (config.background) this.background = config.background;

        if (config.intersection === 0) this.visibilityThreshold = 0;
        else this.visibilityThreshold = config.intersection || 0.75;

        /**
         * @type {{
         *     url: string,
         *     entity: string,
         *     mode: string,
         *     media: string,
         *
         *     streams: Array<{
         *         name: string,
         *         url: string,
         *         entity: string,
         *         mode: string,
         *         media: string,
         *     }>,
         *
         *     title: string,
         *     poster: string,
         *     poster_remote: boolean,
         *     muted: boolean,
         *     intersection: number,
         *     ui: boolean,
         *     ptt: boolean,
         *     style: string,
         *     background: boolean,
         *
         *     server: string,
         *
         *     mse: boolean,
         *     webrtc: boolean,
         *
         *     digital_ptz:{
         *         mouse_drag_pan: boolean,
         *         mouse_wheel_zoom: boolean,
         *         mouse_double_click_zoom: boolean,
         *         touch_pinch_zoom: boolean,
         *         touch_drag_pan: boolean,
         *         touch_tap_drag_zoom: boolean,
         *         persist: boolean|string,
         *     },
         *     ptz:{
         *         opacity: number|string,
         *         service: string,
         *         data_left, data_up, data_right, data_down, data_zoom_in, data_zoom_out, data_home
         *     },
         *     shortcuts:Array<{ name:string, icon:string }>,
         * }} config
         */
        this.config = Object.assign({
            mode: config.ptt && !config.mode ? 'webrtc' :
                config.mse === false ? 'webrtc' : config.webrtc === false ? 'mse' : this.mode,
            media: this.media,
            streams: [{url: config.url, entity: config.entity}],
            poster_remote: config.poster && (config.poster.indexOf('://') > 0 || config.poster.charAt(0) === '/'),
        }, config);

        this.streamID = -1;
        this.nextStream(false);

        this.onhass = [];
    }

    set hass(hass) {
        this._hass = hass;
        this.onhass.forEach(fn => fn());
        // if card in vertical stack - `hass` property assign after `onconnect`
        // this.onconnect();
    }

    get hass() {
        return this._hass;
    }

    /**
     * Called by the Hass to calculate default card height.
     */
    getCardSize() {
        return this.config.ptt ? 6 : 5; // x 50px
    }

    /**
     * Called by the Hass to get defaul card config
     * @return {{url: string}}
     */
    static getStubConfig() {
        return {'url': ''};
    }

    setStatus(mode, status) {
        const divMode = this.querySelector('.mode').innerText;
        if (mode === 'error' && divMode !== 'Loading..' && divMode !== 'Loading...') return;

        this.querySelector('.mode').innerText = mode;
        this.querySelector('.status').innerText = status || '';
    }

    /** @param reload {boolean} */
    nextStream(reload) {
        this.streamID = (this.streamID + 1) % this.config.streams.length;

        const stream = this.config.streams[this.streamID];
        this.config.url = stream.url;
        this.config.entity = stream.entity;
        this.mode = stream.mode || this.config.mode;
        this.media = stream.media || this.config.media;

        if (reload) {
            this.ondisconnect();
            setTimeout(() => this.onconnect(), 100); // wait ws.close event
        }
    }

    /** @return {string} */
    get streamName() {
        return this.config.streams[this.streamID].name || `S${this.streamID}`;
    }

    oninit() {
        super.oninit();
        this.renderMain();
        this.renderPTT();
        this.renderDigitalPTZ();
        this.renderPTZ();
        this.renderCustomUI();
        this.renderShortcuts();
        this.renderStyle();
    }

    onconnect() {
        if (!this.config || !this.hass) return false;
        if (!this.isConnected || this.ws || this.pc) return false;

        const divMode = this.querySelector('.mode').innerText;
        if (divMode === 'Loading..') return;

        this.setStatus('Loading..');

        this.hass.callWS({
            type: 'auth/sign_path', path: '/api/webrtc_mike/ws'
        }).then(data => {
            if (this.config.poster && !this.config.poster_remote) {
                this.video.poster = this.hass.hassUrl(data.path) + '&poster=' + encodeURIComponent(this.config.poster);
            }

            this.wsURL = 'ws' + this.hass.hassUrl(data.path).substring(4);

            if (this.config.entity) {
                this.wsURL += '&entity=' + this.config.entity;
            } else if (this.config.url) {
                this.wsURL += '&url=' + encodeURIComponent(this.config.url);
            } else {
                this.setStatus('IMG');
                return;
            }

            if (this.config.server) {
                this.wsURL += '&server=' + encodeURIComponent(this.config.server);
            }

            if (super.onconnect()) {
                this.setStatus('Loading...');
            } else {
                this.setStatus('error', 'unable to connect');
            }
        }).catch(er => {
            this.setStatus('error', er);
        });
    }

    onopen() {
        const result = super.onopen();

        this.onmessage['stream'] = msg => {
            switch (msg.type) {
                case 'error':
                    this.setStatus('error', msg.value);
                    break;
                case 'mse':
                case 'hls':
                case 'mp4':
                case 'mjpeg':
                    this.setStatus(msg.type.toUpperCase(), this.config.title || '');
                    break;
            }
        };

        return result;
    }

    onpcvideo(ev) {
        super.onpcvideo(ev);

        if (this.pcState !== WebSocket.CLOSED) {
            this.setStatus('RTC', this.config.title || '');
        }
    }

    /**
     * Create a silent audio track so WebKit negotiates the talk channel without microphone access.
     * @return {MediaStreamTrack}
     */
    createPTTSilentTrack() {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) throw new Error('Web Audio is not supported');

        this.pttAudioContext = new AudioContext();
        this.pttSilentDestination = this.pttAudioContext.createMediaStreamDestination();
        this.pttSilentGain = this.pttAudioContext.createGain();
        this.pttSilentSource = this.pttAudioContext.createOscillator();
        this.pttSilentGain.gain.value = 0;
        this.pttSilentSource.connect(this.pttSilentGain);
        this.pttSilentGain.connect(this.pttSilentDestination);
        this.pttSilentSource.start();
        this.pttSilentTrack = this.pttSilentDestination.stream.getAudioTracks()[0];
        return this.pttSilentTrack;
    }

    /** Release resources used by the silent PTT placeholder track. */
    closePTTSilentTrack() {
        if (this.pttSilentTrack) this.pttSilentTrack.stop();
        if (this.pttSilentSource) {
            try {
                this.pttSilentSource.stop();
            } catch (e) {
                // already stopped
            }
        }
        if (this.pttAudioContext) this.pttAudioContext.close().catch(console.warn);
        this.pttSilentTrack = null;
        this.pttSilentSource = null;
        this.pttSilentGain = null;
        this.pttSilentDestination = null;
        this.pttAudioContext = null;
    }

    /**
     * Avoid requesting microphone access during negotiation when push-to-talk is enabled.
     * Negotiate a send-only audio channel using a non-capturing silent track.
     * @param pc {RTCPeerConnection}
     * @return {Promise<RTCSessionDescriptionInit>}
     */
    async createOffer(pc) {
        if (!this.config || !this.config.ptt || !this.media.includes('microphone')) {
            return super.createOffer(pc);
        }

        const media = this.media;
        const silentTrack = this.createPTTSilentTrack();
        this.pttSender = pc.addTransceiver(silentTrack, {direction: 'sendonly'}).sender;

        try {
            this.media = media.split(',').filter(kind => kind !== 'microphone').join(',');
            return await super.createOffer(pc);
        } finally {
            this.media = media;
        }
    }

    ondisconnect() {
        if (this.pttTrack) this.pttTrack.stop();
        this.pttTrack = null;
        this.pttSender = null;
        this.closePTTSilentTrack();
        super.ondisconnect();
    }

    renderMain() {
        const shadow = this.attachShadow({mode: 'open'});
        shadow.innerHTML = `
        <style>
            ha-card {
                width: 100%;
                height: 100%;
                margin: auto;
                overflow: hidden;
                position: relative;
            }
            ha-icon {
                color: white;
                cursor: pointer;
            }
            .player {
                background-color: black;
                height: 100%;
                position: relative; /* important for Safari */
            }
            .player:active {
                cursor: move; /* important for zoom-controller */
            }
            .player .ptz-transform {
                height: 100%;
            }
            .header {
                position: absolute;
                top: 6px;
                left: 10px;
                right: 10px;
                color: white;
                display: flex;
                justify-content: space-between;
                pointer-events: none;
            }
            .mode {
                cursor: pointer;
                opacity: 0.6;
                pointer-events: auto;
            }
        </style>
        <ha-card class="card">
            <div class="player">
                <div class="ptz-transform"></div>
            </div>
            <div class="header">
                <div class="status"></div>
                <div class="mode"></div>
            </div>
        </ha-card>
        `;

        this.querySelector = selectors => this.shadowRoot.querySelector(selectors);
        this.querySelector('.ptz-transform').appendChild(this.video);

        const mode = this.querySelector('.mode');
        mode.addEventListener('click', () => this.nextStream(true));

        if (this.config.muted) this.video.muted = true;
        if (this.config.poster_remote) this.video.poster = this.config.poster;
    }

    renderPTT() {
        if (!this.config.ptt || !this.media.includes('microphone')) return;

        const card = this.querySelector('.card');
        card.insertAdjacentHTML('beforebegin', `
            <style>
                .ptt {
                    padding: 8px;
                    background: var(--ha-card-background, var(--card-background-color, white));
                    text-align: center;
                }
                .ptt-button {
                    width: 100%;
                    min-height: 44px;
                    border: 0;
                    border-radius: 4px;
                    color: var(--primary-text-color);
                    background: var(--secondary-background-color);
                    font: inherit;
                    touch-action: none;
                    cursor: pointer;
                    user-select: none;
                    -webkit-user-select: none;
                }
                .ptt-button.active {
                    color: white;
                    background: var(--error-color, #db4437);
                }
                .ptt-message {
                    min-height: 18px;
                    margin-top: 4px;
                    color: var(--secondary-text-color);
                    font-size: 12px;
                }
                .ptt-message.error {
                    color: var(--error-color, #db4437);
                }
            </style>
        `);
        card.insertAdjacentHTML('afterend', `
            <div class="ptt">
                <button class="ptt-button" type="button">Hold to talk</button>
                <div class="ptt-message"></div>
            </div>
        `);

        const button = this.querySelector('.ptt-button');
        const message = this.querySelector('.ptt-message');

        const resetPlayback = () => {
            if (this.pttVideoMuted !== undefined) {
                this.video.muted = this.pttVideoMuted;
                this.pttVideoMuted = undefined;
            }
            button.classList.remove('active');
            button.innerText = 'Hold to talk';
        };

        const stop = () => {
            this.pttPressed = false;
            const track = this.pttTrack;
            this.pttTrack = null;
            if (track) {
                const replace = this.pttSender && this.pttSilentTrack ?
                    this.pttSender.replaceTrack(this.pttSilentTrack) : Promise.resolve();
                replace.then(() => track.stop(), error => {
                    console.warn(error);
                    track.stop();
                });
            }
            resetPlayback();
        };

        const errorText = error => {
            if (!window.isSecureContext) return 'Microphone requires HTTPS';
            if (error.name === 'NotAllowedError') return 'Microphone permission denied';
            if (error.name === 'NotFoundError') return 'No microphone found';
            return error.message || 'Unable to access microphone';
        };

        const start = async ev => {
            ev.preventDefault();
            if (this.pttPressed) return;

            this.pttPressed = true;
            this.pttVideoMuted = this.video.muted;
            this.video.muted = true;
            button.classList.add('active');
            button.innerText = 'Talking...';
            message.innerText = '';
            message.classList.remove('error');

            try {
                if (this.pttAudioContext && this.pttAudioContext.state === 'suspended') {
                    this.pttAudioContext.resume().catch(console.warn);
                }
                const stream = await navigator.mediaDevices.getUserMedia({audio: true});
                const track = stream.getAudioTracks()[0];
                stream.getTracks().filter(value => value !== track).forEach(value => value.stop());
                if (!track) throw new Error('No microphone track available');

                if (!this.pttSender) {
                    this.pttPressed = false;
                    track.stop();
                    message.innerText = 'Talk channel is not ready';
                    message.classList.add('error');
                    resetPlayback();
                    return;
                }

                if (!this.pttPressed) {
                    track.stop();
                    resetPlayback();
                    return;
                }

                this.pttTrack = track;
                await this.pttSender.replaceTrack(track);
            } catch (error) {
                this.pttPressed = false;
                if (this.pttTrack) this.pttTrack.stop();
                this.pttTrack = null;
                message.innerText = errorText(error);
                message.classList.add('error');
                resetPlayback();
            }
        };

        button.addEventListener('mousedown', start);
        button.addEventListener('touchstart', start, {passive: false});
        for (const event of ['mouseup', 'touchend', 'touchcancel', 'blur']) {
            window.addEventListener(event, stop);
        }
    }

    renderDigitalPTZ() {
        if (this.config.digital_ptz === false) return;
        new DigitalPTZ(
            this.querySelector('.player'),
            this.querySelector('.player .ptz-transform'),
            this.video,
            Object.assign({}, this.config.digital_ptz, {persist_key: this.config.url})
        );
    }

    renderPTZ() {
        if (!this.config.ptz || !this.config.ptz.service) return;

        let hasMove = false;
        let hasZoom = false;
        let hasHome = false;
        for (const prefix of ['', '_start', '_end', '_long']) {
            hasMove = hasMove || this.config.ptz['data' + prefix + '_right'];
            hasMove = hasMove || this.config.ptz['data' + prefix + '_left'];
            hasMove = hasMove || this.config.ptz['data' + prefix + '_up'];
            hasMove = hasMove || this.config.ptz['data' + prefix + '_down'];

            hasZoom = hasZoom || this.config.ptz['data' + prefix + '_zoom_in'];
            hasZoom = hasZoom || this.config.ptz['data' + prefix + '_zoom_out'];

            hasHome = hasHome || this.config.ptz['data' + prefix + '_home'];
        }

        const card = this.querySelector('.card');
        card.insertAdjacentHTML('beforebegin', `
            <style>
                .ptz {
                    position: absolute;
                    top: 50%;
                    right: 10px;
                    transform: translateY(-50%);
                    display: flex;
                    flex-direction: column;
                    gap: 10px;
                    transition: opacity .3s ease-in-out;
                    opacity: ${parseFloat(this.config.ptz.opacity) || 0.4};
                }
                .ptz:hover {
                    opacity: 1 !important;
                }
                .ptz-move {
                    position: relative;
                    background-color: rgba(0, 0, 0, 0.3);
                    border-radius: 50%;
                    width: 80px;
                    height: 80px;
                    display: ${hasMove ? 'block' : 'none'};
                }
                .ptz-zoom {
                    position: relative;
                    width: 80px;
                    height: 40px;
                    background-color: rgba(0, 0, 0, 0.3);
                    border-radius: 4px;
                    display: ${hasZoom ? 'block' : 'none'};
                }
                .ptz-home {
                    position: relative;
                    width: 40px;
                    height: 40px;
                    background-color: rgba(0, 0, 0, 0.3);
                    border-radius: 4px;
                    align-self: center;
                    display: ${hasHome ? 'block' : 'none'};
                }
                .up {
                    position: absolute;
                    top: 5px;
                    left: 50%;
                    transform: translateX(-50%);
                }
                .down {
                    position: absolute;
                    bottom: 5px;
                    left: 50%;
                    transform: translateX(-50%);
                }
                .left {
                    position: absolute;
                    left: 5px;
                    top: 50%;
                    transform: translateY(-50%);
                }
                .right {
                    position: absolute;
                    right: 5px;
                    top: 50%;
                    transform: translateY(-50%);
                }
                .zoom_out {
                    position: absolute;
                    left: 5px;
                    top: 50%;
                    transform: translateY(-50%);
                }
                .zoom_in {
                    position: absolute;
                    right: 5px;
                    top: 50%;
                    transform: translateY(-50%);
                }
                .home {
                    position: absolute;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%);
                }
            </style>
        `);
        card.insertAdjacentHTML('beforeend', `
            <div class="ptz">
                <div class="ptz-move">
                    <ha-icon class="right" icon="mdi:arrow-right"></ha-icon>
                    <ha-icon class="left" icon="mdi:arrow-left"></ha-icon>
                    <ha-icon class="up" icon="mdi:arrow-up"></ha-icon>
                    <ha-icon class="down" icon="mdi:arrow-down"></ha-icon>
                </div>
                <div class="ptz-zoom">
                    <ha-icon class="zoom_in" icon="mdi:plus"></ha-icon>
                    <ha-icon class="zoom_out" icon="mdi:minus"></ha-icon>
                </div>
                <div class="ptz-home">
                    <ha-icon class="home" icon="mdi:home"></ha-icon>
                </div>
            </div>
        `);

        const template = JSON.stringify(this.config.ptz);
        const handle = path => {
            if (!this.config.ptz['data_' + path]) return;
            const config = template.indexOf('${') < 0 ? this.config.ptz : JSON.parse(eval('`' + template + '`'));
            const [domain, service] = config.service.split('.', 2);
            const data = config['data_' + path];
            this.hass.callService(domain, service, data);
        };
        const ptz = this.querySelector('.ptz');
        for (const [start, end] of [['touchstart', 'touchend'], ['mousedown', 'mouseup']]) {
            ptz.addEventListener(start, startEvt => {
                const {className} = startEvt.target;
                startEvt.preventDefault();
                handle('start_' + className);
                window.addEventListener(end, endEvt => {
                    endEvt.preventDefault();
                    handle('end_' + className);
                    if (endEvt.timeStamp - startEvt.timeStamp > 400) {
                        handle('long_' + className);
                    } else {
                        handle(className);
                    }
                }, {once: true});
            });
        }
    }

    saveScreenshot() {
        const a = document.createElement('a');

        if (this.video.videoWidth && this.video.videoHeight) {
            const canvas = document.createElement('canvas');
            canvas.width = this.video.videoWidth;
            canvas.height = this.video.videoHeight;
            canvas.getContext('2d').drawImage(this.video, 0, 0, canvas.width, canvas.height);
            a.href = canvas.toDataURL('image/jpeg');
        } else if (this.video.poster && this.video.poster.startsWith('data:image/jpeg')) {
            a.href = this.video.poster;
        } else {
            return;
        }

        const ts = new Date().toISOString().substring(0, 19).replaceAll('-', '').replaceAll(':', '');
        a.download = `snapshot_${ts}.jpeg`;
        a.click();
    }

    renderCustomUI() {
        if (!this.config.ui) return;

        this.video.controls = false;
        this.video.style.pointerEvents = 'none';

        const card = this.querySelector('.card');
        card.insertAdjacentHTML('beforebegin', `
            <style>
                .spinner {
                    position: absolute;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%);
                }
                .controls {
                    position: absolute;
                    left: 5px;
                    right: 5px;
                    bottom: 5px;
                    display: flex;
                    align-items: center;
                }
                .space {
                    width: 100%;
                }
                .volume {
                    display: none;
                }
                .stream {
                    padding-top: 2px;
                    margin-left: 2px;
                    font-weight: 400;
                    font-size: 20px;
                    color: white;
                    display: none;
                    cursor: pointer;
                }
            </style>
        `);
        card.insertAdjacentHTML('beforeend', `
            <div class="ui">
                <ha-circular-progress class="spinner"></ha-circular-progress>
                <div class="controls">
                    <ha-icon class="fullscreen" icon="mdi:fullscreen"></ha-icon>
                    <ha-icon class="screenshot" icon="mdi:floppy"></ha-icon>
                    <ha-icon class="pictureinpicture" icon="mdi:picture-in-picture-bottom-right"></ha-icon>
                    <span class="stream">${this.streamName}</span>
                    <span class="space"></span>
                    <ha-icon class="play" icon="mdi:play"></ha-icon>
                    <ha-icon class="volume" icon="mdi:volume-high"></ha-icon>
                </div>
            </div>
        `);

        const video = this.video;

        const fullscreen = this.querySelector('.fullscreen');
        if (this.requestFullscreen) {
            this.addEventListener('fullscreenchange', () => {
                fullscreen.icon = document.fullscreenElement ? 'mdi:fullscreen-exit' : 'mdi:fullscreen';
            });
        } else if (video.webkitEnterFullscreen) {
            this.requestFullscreen = () => new Promise((resolve, reject) => {
                try {
                    video.webkitEnterFullscreen();
                } catch (e) {
                    reject(e);
                }
            });
            video.addEventListener('webkitendfullscreen', () => {
                setTimeout(() => this.play(), 1000); // fix bug in iOS
            });
        } else {
            fullscreen.style.display = 'none';
        }

        const pip = this.querySelector('.pictureinpicture');
        if (video.requestPictureInPicture) {
            video.addEventListener('enterpictureinpicture', () => {
                pip.icon = 'mdi:rectangle';
                this.background = true;
            });
            video.addEventListener('leavepictureinpicture', () => {
                pip.icon = 'mdi:picture-in-picture-bottom-right';
                this.background = this.config.background;
                this.play();
            });
        } else {
            pip.style.display = 'none';
        }

        const ui = this.querySelector('.ui');
        ui.addEventListener('click', ev => {
            const icon = ev.target.icon;
            if (icon === 'mdi:play') {
                this.play();
            } else if (icon === 'mdi:volume-mute') {
                video.muted = false;
            } else if (icon === 'mdi:volume-high') {
                video.muted = true;
            } else if (icon === 'mdi:fullscreen') {
                this.requestFullscreen().catch(console.warn);
            } else if (icon === 'mdi:fullscreen-exit') {
                document.exitFullscreen().catch(console.warn);
            } else if (icon === 'mdi:floppy') {
                this.saveScreenshot();
            } else if (icon === 'mdi:picture-in-picture-bottom-right') {
                video.requestPictureInPicture().catch(console.warn);
            } else if (icon === 'mdi:rectangle') {
                document.exitPictureInPicture().catch(console.warn);
            } else if (ev.target.className === 'stream') {
                this.nextStream(true);
                ev.target.innerText = this.streamName;
            }
        });

        const spinner = this.querySelector('.spinner');
        video.addEventListener('waiting', () => {
            spinner.style.display = 'block';
        });
        video.addEventListener('playing', () => {
            spinner.style.display = 'none';
        });

        const play = this.querySelector('.play');
        video.addEventListener('play', () => {
            play.style.display = 'none';
        });
        video.addEventListener('pause', () => {
            play.style.display = 'block';
        });

        const volume = this.querySelector('.volume');
        video.addEventListener('loadeddata', () => {
            volume.style.display = this.hasAudio ? 'block' : 'none';
        });
        video.addEventListener('volumechange', () => {
            volume.icon = video.muted ? 'mdi:volume-mute' : 'mdi:volume-high';
        });

        const stream = this.querySelector('.stream');
        stream.style.display = this.config.streams.length > 1 ? 'block' : 'none';
    }

    renderShortcuts() {
        if (!this.config.shortcuts) return;

        const card = this.querySelector('.card');
        card.insertAdjacentHTML('beforebegin', `
            <style>
                .shortcuts {
                    position: absolute;
                    top: 5px;
                    left: 5px;
                }
            </style>
        `);
        card.insertAdjacentHTML('beforeend', '<div class="shortcuts"></div>');

        const shortcuts = this.querySelector('.shortcuts');
        shortcuts.addEventListener('click', ev => {
            const value = this.config.shortcuts[ev.target.dataset.index];
            if (value.more_info !== undefined) {
                const event = new Event('hass-more-info', {
                    bubbles: true,
                    cancelable: true,
                    composed: true,
                });
                event.detail = {entityId: value.more_info};
                ev.target.dispatchEvent(event);
            }
            if (value.service !== undefined) {
                const [domain, name] = value.service.split('.');
                this.hass.callService(domain, name, value.service_data || {});
            }
        });

        this.renderTemplate('shortcuts', () => {
            const innerHTML = this.config.shortcuts.map((value, index) => `
                <ha-icon data-index="${index}" icon="${value.icon}" title="${value.name}"></ha-icon>
            `).join('');

            if (shortcuts.innerHTML !== innerHTML) {
                shortcuts.innerHTML = innerHTML;
            }
        });
    }

    renderStyle() {
        if (!this.config.style) return;

        const style = document.createElement('style');
        const card = this.querySelector('.card');
        card.insertAdjacentElement('beforebegin', style);

        this.renderTemplate('style', () => {
            style.innerText = this.config.style;
        });
    }

    renderTemplate(name, renderHTML) {
        const config = this.config[name];
        // support config param as string or as object
        const template = typeof config === 'string' ? config : JSON.stringify(config);
        // check if config param has template
        if (template.indexOf('${') >= 0) {
            const render = () => {
                try {
                    const states = this.hass ? this.hass.states : undefined;
                    this.config[name] = JSON.parse(eval('`' + template + '`'));
                    renderHTML();
                } catch (e) {
                    console.debug(e);
                }
            };
            this.onhass.push(render);
            render();
        } else {
            renderHTML();
        }
    }

    get hasAudio() {
        return (
            (this.video.srcObject && this.video.srcObject.getAudioTracks && this.video.srcObject.getAudioTracks().length) ||
            (this.video.mozHasAudio || this.video.webkitAudioDecodedByteCount) ||
            (this.video.audioTracks && this.video.audioTracks.length)
        );
    }
}

customElements.define('webrtc-camera-mike', WebRTCCamera);

const card = {
    type: 'webrtc-camera-mike',
    name: 'WebRTC Camera Mike',
    preview: false,
    description: 'WebRTC camera allows you to view the stream of almost any camera without delay',
};
// Apple iOS 12 doesn't support `||=`
if (window.customCards) window.customCards.push(card);
else window.customCards = [card];
