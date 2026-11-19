/*
 * PlayHls.js
 *
 * Twitch "Enhanced Broadcasting" channels deliver HLS with fMP4 segments (#EXT-X-MAP, audio and video
 * muxed in one fMP4). Samsung AVPlay on older TVs (confirmed on a 2018 Tizen 4.0 UE55NU8042) fails
 * with PLAYER_ERROR_NOT_SUPPORTED_FORMAT while still reporting PLAYING, so the screen stays black.
 *
 * PlayHls_CreatePlayer(webapis.avplay) returns an object with the same API subset the app uses on
 * Play_avplay. On prepareAsync it fetches the playlist; fMP4 streams are played by hls.js in a <video>
 * element (MSE), everything else (TS live streams, mp4 clips) keeps using AVPlay exactly as before.
 * hls.js is loaded on demand from the same folder as master.js (release/githubio/js/hls.min.js).
 */

var PlayHls_LibUrlFallback = 'https://shotsel.github.io/smarttv-twitch/release/githubio/js/hls.min.js';
var PlayHls_LibState = 0; // 0 not loaded, 1 loading, 2 loaded, 3 failed
var PlayHls_LibCallbacks = [];
var PlayHls_Backend = null;

function PlayHls_Log(text) {
    console.log('PlayHls: ' + text);
}

function PlayHls_LibUrl() {
    var scripts = document.getElementsByTagName('script'),
        src,
        i;

    for (i = 0; i < scripts.length; i++) {
        src = scripts[i].src || '';
        if (src.indexOf('/js/master.js') !== -1) return src.replace('/js/master.js', '/js/hls.min.js').split('?')[0];
    }

    return PlayHls_LibUrlFallback;
}

function PlayHls_LoadLib(callback) {
    if (window.Hls || PlayHls_LibState === 2) {
        PlayHls_LibState = 2;
        callback(true);
        return;
    }
    if (PlayHls_LibState === 3) {
        callback(false);
        return;
    }

    PlayHls_LibCallbacks.push(callback);
    if (PlayHls_LibState === 1) return;

    PlayHls_LibState = 1;
    var script = document.createElement('script');
    script.src = PlayHls_LibUrl();
    PlayHls_Log('loading ' + script.src);

    var done = function (ok) {
        PlayHls_LibState = ok && window.Hls ? 2 : 3;
        PlayHls_Log('hls.js load ' + (PlayHls_LibState === 2 ? 'OK ' + window.Hls.version : 'FAILED'));
        var callbacks = PlayHls_LibCallbacks;
        PlayHls_LibCallbacks = [];
        for (var i = 0; i < callbacks.length; i++) callbacks[i](PlayHls_LibState === 2);
    };

    script.onload = function () {
        done(true);
    };
    script.onerror = function () {
        done(false);
    };
    document.head.appendChild(script);
}

function PlayHls_CanUseMse() {
    var MS = window.MediaSource || window.WebKitMediaSource;
    return !!(MS && MS.isTypeSupported && MS.isTypeSupported('video/mp4; codecs="avc1.4D401F,mp4a.40.2"'));
}

function PlayHls_Get(url, callback) {
    var xmlHttp = new XMLHttpRequest();
    xmlHttp.open('GET', url, true);
    xmlHttp.timeout = 5000;
    xmlHttp.ontimeout = function () {};
    xmlHttp.onreadystatechange = function () {
        if (xmlHttp.readyState === 4) callback(xmlHttp.status === 200 ? xmlHttp.responseText : null);
    };
    xmlHttp.send(null);
}

function PlayHls_ResolveUrl(base, relative) {
    if (/^https?:\/\//.test(relative)) return relative;
    if (relative.charAt(0) === '/') return base.split('/').slice(0, 3).join('/') + relative;
    return base.split('?')[0].replace(/[^\/]*$/, '') + relative;
}

function PlayHls_FirstVariant(master, baseUrl) {
    var lines = master.split('\n');
    for (var i = 0; i < lines.length; i++) {
        if (lines[i].indexOf('#EXT-X-STREAM-INF') === 0) {
            for (var j = i + 1; j < lines.length; j++) {
                var line = lines[j].trim();
                if (line && line.charAt(0) !== '#') return PlayHls_ResolveUrl(baseUrl, line);
            }
        }
    }
    return null;
}

// callback(true) when the stream should be played by hls.js (fMP4 segments)
function PlayHls_IsFmp4Stream(url, callback) {
    if (!url || url.indexOf('.m3u8') === -1 || !PlayHls_CanUseMse()) {
        callback(false);
        return;
    }

    PlayHls_Get(url, function (text) {
        if (!text) {
            callback(false);
            return;
        }

        if (text.indexOf('#EXT-X-STREAM-INF') !== -1) {
            var variant = PlayHls_FirstVariant(text, url);
            if (!variant) {
                callback(false);
                return;
            }
            PlayHls_Get(variant, function (media) {
                callback(!!media && media.indexOf('#EXT-X-MAP') !== -1);
            });
            return;
        }

        callback(text.indexOf('#EXT-X-MAP') !== -1);
    });
}

// <video> + hls.js player that mimics the webapis.avplay calls used by the app
function PlayHls_CreateBackend() {
    var video = null,
        hls = null,
        listener = null,
        url = null,
        prepared = false,
        startPosition = -1,
        state = 'NONE',
        fatalRecover = 0,
        mediaRecover = 0,
        okCallback = null,
        errorCallback = null,
        levelDetails = null,
        rect = null,
        buffering = false,
        loadStopped = false;

    function fire(name, value) {
        if (listener && listener[name]) {
            try {
                listener[name](value);
            } catch (e) {
                console.log('PlayHls listener ' + name + ' ' + e);
            }
        }
    }

    function applyRect() {
        if (!video) return;
        // AVPlay rects are in screen pixels, convert to % of the full screen player container
        var r = rect || [0, 0, screen.width, screen.height];
        video.style.left = (r[0] * 100) / screen.width + '%';
        video.style.top = (r[1] * 100) / screen.height + '%';
        video.style.width = (r[2] * 100) / screen.width + '%';
        video.style.height = (r[3] * 100) / screen.height + '%';
    }

    function ensureVideo() {
        if (video) return;
        video = document.createElement('video');
        video.id = 'hls_video';
        video.setAttribute('style', 'position: absolute; z-index: 0; background: #000; object-fit: contain; display: none;');
        var scene = document.getElementById('scene2') || document.body;
        scene.insertBefore(video, scene.firstChild);
        applyRect();

        video.addEventListener('waiting', function () {
            if (!buffering) {
                buffering = true;
                fire('onbufferingstart');
            }
        });
        video.addEventListener('playing', function () {
            if (buffering) {
                buffering = false;
                fire('onbufferingcomplete');
            }
        });
        video.addEventListener('timeupdate', function () {
            fire('oncurrentplaytime', Math.floor(video.currentTime * 1000));
        });
        video.addEventListener('ended', function () {
            fire('onstreamcompleted');
        });
    }

    function destroyHls() {
        if (hls) {
            try {
                hls.destroy();
            } catch (e) {
                console.log('PlayHls destroy ' + e);
            }
            hls = null;
        }
    }

    function failPrepare(reason) {
        var cb = errorCallback;
        okCallback = null;
        errorCallback = null;
        destroyHls();
        state = 'IDLE';
        PlayHls_Log('prepare failed ' + reason);
        if (cb) cb({ name: reason, message: reason });
    }

    function onHlsError(data) {
        PlayHls_Log('error ' + data.type + ' ' + data.details + (data.fatal ? ' FATAL' : ''));
        if (!data.fatal) return;

        var Hls = window.Hls;
        if (!prepared) {
            failPrepare(data.type === Hls.ErrorTypes.NETWORK_ERROR ? 'PLAYER_ERROR_CONNECTION_FAILED' : 'PLAYER_ERROR_NOT_SUPPORTED_FORMAT');
            return;
        }

        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && fatalRecover < 3) {
            fatalRecover++;
            hls.startLoad();
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecover < 2) {
            mediaRecover++;
            if (mediaRecover === 2) hls.swapAudioCodec();
            hls.recoverMediaError();
        } else {
            destroyHls();
            state = 'IDLE';
            fire('onerror', data.type === Hls.ErrorTypes.NETWORK_ERROR ? 'PLAYER_ERROR_CONNECTION_FAILED' : 'PLAYER_ERROR_NOT_SUPPORTED_FORMAT');
        }
    }

    return {
        isHls: true,
        open: function (newUrl) {
            url = newUrl;
            prepared = false;
            startPosition = -1;
            fatalRecover = 0;
            mediaRecover = 0;
            levelDetails = null;
            buffering = false;
            state = 'IDLE';
        },
        prepareAsync: function (ok, error) {
            var Hls = window.Hls;
            okCallback = ok;
            errorCallback = error;
            ensureVideo();
            destroyHls();
            loadStopped = false;
            video.style.display = 'block';

            hls = new Hls({
                enableWorker: true,
                startPosition: startPosition,
                maxBufferLength: 30,
                backBufferLength: 30,
                liveSyncDurationCount: 3
            });

            hls.on(Hls.Events.LEVEL_LOADED, function (event, data) {
                levelDetails = data.details;
                if (!prepared) {
                    prepared = true;
                    state = 'READY';
                    var cb = okCallback;
                    okCallback = null;
                    errorCallback = null;
                    PlayHls_Log('ready live=' + levelDetails.live + ' fragments=' + levelDetails.fragments.length);
                    if (cb) cb();
                }
            });
            hls.on(Hls.Events.FRAG_BUFFERED, function () {
                fatalRecover = 0;
            });
            hls.on(Hls.Events.BUFFER_CODECS, function (event, data) {
                var tracks = [];
                for (var key in data) {
                    if (data.hasOwnProperty(key) && data[key]) tracks.push(key + ' ' + data[key].container + ' ' + data[key].codec);
                }
                PlayHls_Log('codecs ' + tracks.join(' | '));
            });
            hls.on(Hls.Events.ERROR, function (event, data) {
                onHlsError(data);
            });

            hls.loadSource(url);
            hls.attachMedia(video);
        },
        play: function () {
            if (!video) return;
            state = 'PLAYING';
            if (hls && loadStopped) {
                loadStopped = false;
                hls.startLoad(-1);
            }
            var promise = video.play();
            if (promise && promise.catch) {
                promise.catch(function (e) {
                    PlayHls_Log('video.play() ' + e);
                });
            }
        },
        pause: function () {
            if (video) video.pause();
            state = 'PAUSED';
        },
        stop: function () {
            if (hls) {
                hls.stopLoad();
                loadStopped = true;
            }
            if (video) video.pause();
            state = 'IDLE';
        },
        close: function () {
            destroyHls();
            okCallback = null;
            errorCallback = null;
            if (video) {
                video.pause();
                video.removeAttribute('src');
                try {
                    video.load();
                } catch (e) {}
                video.style.display = 'none';
            }
            prepared = false;
            state = 'NONE';
        },
        getState: function () {
            return state;
        },
        getCurrentTime: function () {
            return video ? Math.floor(video.currentTime * 1000) : 0;
        },
        getDuration: function () {
            if (video && isFinite(video.duration) && video.duration > 0) return Math.floor(video.duration * 1000);
            if (levelDetails && !levelDetails.live) return Math.floor(levelDetails.totalduration * 1000);
            return 0;
        },
        seekTo: function (ms) {
            if (!prepared || !video) startPosition = ms / 1000;
            else video.currentTime = ms / 1000;
        },
        getStreamingProperty: function (name) {
            if (name === 'GET_LIVE_DURATION' && video && video.seekable.length) {
                return Math.floor(video.seekable.start(0) * 1000) + '|' + Math.floor(video.seekable.end(video.seekable.length - 1) * 1000);
            }
            throw new Error('PlayHls getStreamingProperty ' + name + ' not supported');
        },
        setListener: function (newListener) {
            listener = newListener;
        },
        setDisplayRect: function (x, y, width, height) {
            rect = [x, y, width, height];
            applyRect();
        },
        setDisplayMethod: function () {},
        setBufferingParam: function () {},
        setSilentSubtitle: function () {},
        setStreamingProperty: function () {},
        getTotalTrackInfo: function () {
            return [];
        }
    };
}

// Facade with the webapis.avplay API: picks AVPlay or hls.js per stream in prepareAsync
function PlayHls_CreatePlayer(avplay) {
    var backend = null, // the player in use for the current url, null while undecided
        pendingUrl = null,
        queue = [],
        token = 0,
        lastRect = null;

    function current() {
        return backend || avplay;
    }

    // calls made between open() and the decision are replayed on the chosen backend
    function deferred(name) {
        return function () {
            var args = Array.prototype.slice.call(arguments);
            if (name === 'setDisplayRect') lastRect = args;
            if (!backend && pendingUrl) {
                queue.push([name, args]);
                return;
            }
            var target = current();
            return target[name].apply(target, args);
        };
    }

    function direct(name, idleValue) {
        return function () {
            if (!backend && pendingUrl) return idleValue;
            var target = current();
            return target[name].apply(target, arguments);
        };
    }

    function start(target, url, ok, error) {
        backend = target;
        target.open(url);
        if (target !== avplay && lastRect) target.setDisplayRect.apply(target, lastRect);
        var calls = queue;
        queue = [];
        for (var i = 0; i < calls.length; i++) {
            try {
                target[calls[i][0]].apply(target, calls[i][1]);
            } catch (e) {
                console.log('PlayHls replay ' + calls[i][0] + ' ' + e);
            }
        }
        if (target === avplay && ok === undefined && error === undefined) avplay.prepareAsync();
        else target.prepareAsync(ok, error);
    }

    return {
        open: function (url) {
            token++;
            backend = null;
            queue = [];
            pendingUrl = url;
        },
        prepareAsync: function (ok, error) {
            if (backend || !pendingUrl) {
                current().prepareAsync(ok, error);
                return;
            }

            var url = pendingUrl,
                myToken = ++token;

            PlayHls_IsFmp4Stream(url, function (isFmp4) {
                if (myToken !== token) return;

                if (!isFmp4) {
                    start(avplay, url, ok, error);
                    return;
                }

                PlayHls_Log('fMP4 stream, using hls.js');
                PlayHls_LoadLib(function (loaded) {
                    if (myToken !== token) return;
                    if (!loaded || !window.Hls.isSupported()) {
                        start(avplay, url, ok, error);
                        return;
                    }
                    if (!PlayHls_Backend) PlayHls_Backend = PlayHls_CreateBackend();
                    start(PlayHls_Backend, url, ok, error);
                });
            });
        },
        stop: function () {
            // cancels an undecided prepareAsync; the app always closes after stop
            token++;
            var target = current();
            if (!backend) pendingUrl = null;
            target.stop();
        },
        close: function () {
            token++;
            var target = current();
            backend = null;
            pendingUrl = null;
            queue = [];
            target.close();
        },
        play: direct('play'),
        pause: direct('pause'),
        getState: direct('getState', 'IDLE'),
        getCurrentTime: direct('getCurrentTime', 0),
        getDuration: direct('getDuration', 0),
        getStreamingProperty: direct('getStreamingProperty', ''),
        getTotalTrackInfo: direct('getTotalTrackInfo', []),
        seekTo: deferred('seekTo'),
        setListener: deferred('setListener'),
        setDisplayRect: deferred('setDisplayRect'),
        setDisplayMethod: deferred('setDisplayMethod'),
        setBufferingParam: deferred('setBufferingParam'),
        setSilentSubtitle: deferred('setSilentSubtitle'),
        setStreamingProperty: deferred('setStreamingProperty')
    };
}
