/**
 * dsh-plugin-browser — BROWSER half.
 *
 * Served at /plugins/dsh-plugin-browser/client.js by the host's client-modules
 * scanner (because package.json declares dsh.client.platform "web") and injected
 * via window.__DSH_BOOT__. Executing it only REGISTERS a factory through
 * window.__ModuleLoader__.load({id, factory}).
 *
 * apply(ctx) mounts a visible browser pane into the "shell.overlay" slot. The
 * pane is a real <iframe>: the human watches it. The component polls the host
 * for commands, executes them, extracts the active tab's text and pushes it
 * back over /api/preview/state so read_preview sees what is actually on screen.
 *
 * Two reading paths, and the difference matters:
 *   - SAME-ORIGIN (local files served by the host, localhost): read straight
 *     from the live DOM. True rendered text, JS included, free to re-read.
 *   - CROSS-ORIGIN: the browser blocks DOM access, so the URL is fetched once
 *     per navigation and parsed. Costly, so it is cached rather than repeated.
 *
 * @module dsh-plugin-browser/client
 */

window.__ModuleLoader__.load({
	id: "dsh-plugin-browser",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var react = require("react");
		var useEffect = react.useEffect;
		var useState = react.useState;
		var useRef = react.useRef;
		var useCallback = react.useCallback;
		var h = react.createElement;

		// ── constants ────────────────────────────────────────────────────────
		var STATE_PATH = "/api/preview/state";
		var COMMANDS_PATH = "/api/preview/commands";
		var COMMAND_POLL_MS = 500;
		var LIVE_PUSH_MS = 2000;
		var PANE_TOP = 44;              // clear the top chrome
		var MIN_W = 320, MAX_W = 1200, DEFAULT_W = 460;
		var WIDTH_KEY = "dsh-preview-width";
		var LIVE_PATH = "/api/preview/live";

		/**
		 * Are we running inside the desktop shell?
		 *
		 * In a plain browser tab, a web page cannot embed a real browsing
		 * context, so the pane mirrors a separate Chrome over CDP. Inside the
		 * Electron shell the same page gets <webview>: a genuine browsing
		 * context with its own process and session, embedded directly. No
		 * screencast, no input forwarding, no scaling -- it simply IS a browser.
		 *
		 * Detected from the user agent rather than a Node global, because the
		 * shell runs the renderer with nodeIntegration off.
		 */
		var IS_SHELL = typeof navigator !== "undefined"
			&& /Electron\//.test(navigator.userAgent || "");

		function postJson(path, body) {
			return fetch(path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body)
			}).then(function (r) { return r.json().catch(function () { return null; }); })
				.catch(function () { return null; });
		}

		// The host keeps a short window of commands rather than draining them, so
		// several panes can be open at once without one swallowing the others'
		// work. Each pane tracks the last sequence it saw.
		var commandCursor = -1;

		function pollCommands() {
			var q = commandCursor < 0 ? "" : "?since=" + commandCursor;
			return fetch(COMMANDS_PATH + q, { method: "GET", cache: "no-store" })
				.then(function (r) { return r.json(); })
				.then(function (d) {
					if (!d) return [];
					// First poll only establishes the cursor: a pane that just loaded
					// should show what is on screen, not replay the backlog.
					if (commandCursor < 0) { commandCursor = d.seq || 0; return []; }
					if (typeof d.seq === "number") commandCursor = d.seq;
					return Array.isArray(d.commands) ? d.commands : [];
				})
				.catch(function () { return []; });
		}

		function collapse(text) {
			return String(text || "").replace(new RegExp(String.fromCharCode(160),"g"), " ")
				.split("\n").map(function (l) { return l.trim(); })
				.filter(Boolean).join("\n");
		}

		function htmlToText(html) {
			try {
				var doc = new DOMParser().parseFromString(html, "text/html");
				var kill = doc.querySelectorAll("script, style, noscript, template");
				for (var i = 0; i < kill.length; i++) {
					var p = kill[i].parentNode; if (p) p.removeChild(kill[i]);
				}
				var body = doc.body;
				if (!body) return "";
				return collapse(body.innerText || body.textContent || "");
			} catch (e) { return ""; }
		}

		/** The iframe document, or null when the browser blocks it (cross-origin). */
		function frameDocument(frame) {
			try { return (frame && frame.contentWindow && frame.contentWindow.document) || null; }
			catch (e) { return null; }
		}

		/** What the user should see in the address bar for a tab. */
		function displayUrl(tab) {
			if (!tab) return "";
			// siteUrl / filePath are what the human asked for; tab.url is the
			// internal proxy or file-serving route and is meaningless to read.
			return tab.siteUrl || tab.filePath || tab.url || "";
		}

		function readWidth() {
			try {
				var v = parseInt(window.localStorage.getItem(WIDTH_KEY) || "", 10);
				if (v >= MIN_W && v <= MAX_W) return v;
			} catch (e) { /* ignore */ }
			return DEFAULT_W;
		}

		// ── layout rail ──────────────────────────────────────────────────────
		//
		// The harness shell is a CSS grid whose inline `grid-template-columns`
		// the layout package owns (e.g. "56px minmax(0px,1fr) 0px"). Appending a
		// fourth track makes the conversation genuinely give up space instead of
		// being covered — which is the whole difference between a floating widget
		// and something that feels part of the app.
		//
		// The proper seat would be the shell's `details` slot, but it is declared
		// `kind: "single"` and the shipped conversation package already owns it,
		// so a plugin cannot register there without evicting the tool-details
		// panel. Reserving a track is the honest alternative.
		//
		// Everything here fails SAFE: if the frame cannot be found or its shape
		// changes, reserve() returns false and the pane falls back to floating.

		var RAIL_ATTR = "data-dsh-preview-rail";

		function findFrame() {
			// [data-shell-overlay] is an explicit attribute the layout sets, so it
			// survives CSS-module hashing in a way a class name would not.
			var ov = document.querySelector("[data-shell-overlay]");
			return (ov && ov.parentElement) || null;
		}

		/** Strip any track we previously appended, returning the shell's own template. */
		function baseTemplate(frame) {
			var t = frame.style.gridTemplateColumns || "";
			var marker = frame.getAttribute(RAIL_ATTR);
			if (marker && t.endsWith(" " + marker)) return t.slice(0, -(marker.length + 1));
			return t;
		}

		/**
		 * Reserve a right-hand track of `width` px.
		 * @returns {boolean} whether the shell was in a shape we could extend.
		 */
		function reserveRail(width) {
			var frame = findFrame();
			if (!frame) return false;
			var cs = window.getComputedStyle(frame);
			if (cs.display !== "grid") return false;

			var spacer = frame.querySelector("[" + RAIL_ATTR + "-col]");
			if (!spacer) {
				spacer = document.createElement("div");
				spacer.setAttribute(RAIL_ATTR + "-col", "1");
				// Purely a spacer: the pane itself is painted over it, flush right.
				spacer.style.cssText = "min-width:0;overflow:hidden";
				frame.appendChild(spacer);
			}
			var track = width + "px";
			frame.setAttribute(RAIL_ATTR, track);
			var base = baseTemplate(frame);
			if (!base) return false;
			frame.style.gridTemplateColumns = base + " " + track;
			return true;
		}

		function releaseRail() {
			var frame = findFrame();
			if (!frame) return;
			var base = baseTemplate(frame);
			frame.removeAttribute(RAIL_ATTR);
			var spacer = frame.querySelector("[" + RAIL_ATTR + "-col]");
			if (spacer && spacer.parentElement) spacer.parentElement.removeChild(spacer);
			if (base) frame.style.gridTemplateColumns = base;
		}

		/**
		 * A live view of the real browser.
		 *
		 * Frames are JPEGs polled from the host and drawn into an <img>; mouse and
		 * keyboard events on that image are forwarded back as CDP input. This is
		 * the only way the pane can show a page that refuses to be framed, or one
		 * the user is logged into -- an iframe can do neither.
		 *
		 * Coordinates are scaled: the image is displayed at whatever width the
		 * pane happens to be, while the page renders at the viewport we set.
		 */
		/**
		 * The browser pane, inside the desktop shell: a real <webview>.
		 *
		 * This is the whole point of the shell. There is no stream here -- the
		 * element is an actual browsing context in its own process, so it
		 * paints itself, handles its own input, scrolls at native speed, and
		 * holds its own cookie jar. Nothing is mirrored and nothing is scaled.
		 *
		 * It is built imperatively rather than as JSX. React has no knowledge of
		 * <webview>, and letting it manage `src` fights the element's own
		 * navigation handling; creating it by hand keeps React out of the way and
		 * makes the lifecycle explicit.
		 *
		 * `partition` is a PERSISTENT session, so a login here survives a
		 * restart -- and it is a session of this app's own, so the user's daily
		 * browser is untouched either way.
		 */
		function ShellView(props) {
			var boxRef = useRef(null);
			var elRef = useRef(null);
			var onNav = props.onNav;
			var viewRef = props.viewRef;
			var initialUrl = props.url;

			// Mount once. Re-creating the element on every render would reload
			// the page and lose scroll position and form state.
			useEffect(function () {
				var box = boxRef.current;
				if (!box) return;
				var el = document.createElement("webview");
				el.setAttribute("partition", "persist:dshbrowser");
				el.setAttribute("allowpopups", "true");
				el.setAttribute("src", initialUrl || "about:blank");
				el.style.width = "100%";
				el.style.height = "100%";
				el.style.display = "flex";
				el.style.background = "#fff";
				box.appendChild(el);
				elRef.current = el;
				if (viewRef) viewRef.current = el;

				function report(navUrl) {
					if (!onNav) return;
					var title = "";
					try { title = el.getTitle() || ""; } catch (e) { /* not ready */ }
					onNav(navUrl || safeUrl(el), title);
				}
				// did-navigate fires for real navigations; -in-page covers SPA
				// route changes, which is most of the modern web.
				function onDidNavigate(e) { report(e && e.url); }
				function onInPage(e) { if (e && e.isMainFrame) report(e.url); }
				function onTitle(e) { if (onNav) onNav(safeUrl(el), (e && e.title) || ""); }
				function onStart() { if (props.onLoading) props.onLoading(true); }
				function onStop() { if (props.onLoading) props.onLoading(false); report(null); }

				el.addEventListener("did-navigate", onDidNavigate);
				el.addEventListener("did-navigate-in-page", onInPage);
				el.addEventListener("page-title-updated", onTitle);
				el.addEventListener("did-start-loading", onStart);
				el.addEventListener("did-stop-loading", onStop);

				return function () {
					el.removeEventListener("did-navigate", onDidNavigate);
					el.removeEventListener("did-navigate-in-page", onInPage);
					el.removeEventListener("page-title-updated", onTitle);
					el.removeEventListener("did-start-loading", onStart);
					el.removeEventListener("did-stop-loading", onStop);
					if (viewRef && viewRef.current === el) viewRef.current = null;
					elRef.current = null;
					try { box.removeChild(el); } catch (e) { /* already gone */ }
				};
			}, []);

			// Navigate on url change -- but only when it is genuinely different
			// from where the view already is, or a redirect would bounce us back
			// to the address we started from.
			useEffect(function () {
				var el = elRef.current;
				if (!el || !props.url) return;
				if (sameTarget(safeUrl(el), props.url)) return;
				try { el.loadURL(props.url); }
				catch (e) { el.setAttribute("src", props.url); }
			}, [props.url]);

			return h("div", {
				ref: boxRef,
				style: { position: "relative", width: "100%", height: "100%", background: "#fff", overflow: "hidden", display: "flex" }
			});
		}

		/** A webview's current URL, or "" before it is ready. */
		function safeUrl(el) {
			try { return el.getURL() || ""; } catch (e) { return ""; }
		}

		/** Same address, ignoring a trailing slash and the scheme's default form. */
		function sameTarget(a, b) {
			var x = String(a || "").replace(/\/$/, "");
			var y = String(b || "").replace(/\/$/, "");
			if (x === y) return true;
			// "cnn.com" typed vs "https://cnn.com/" landed.
			return x.replace(/^https?:\/\//, "") === y.replace(/^https?:\/\//, "");
		}

		function LiveView(props) {
			var imgRef = useRef(null);
			var boxRef = useRef(null);
			var srcState = useState(""); var src = srcState[0], setSrc = srcState[1];
			var sizeRef = useRef({ w: 900, h: 700 });

			// Match the remote viewport to the pane so nothing is letterboxed.
			useEffect(function () {
				var box = boxRef.current;
				if (!box) return;
				function sync() {
					var r = box.getBoundingClientRect();
					var w = Math.max(320, Math.round(r.width));
					var h = Math.max(240, Math.round(r.height));
					if (Math.abs(w - sizeRef.current.w) < 8 && Math.abs(h - sizeRef.current.h) < 8) return;
					sizeRef.current = { w: w, h: h };
					var dpr = (typeof window !== "undefined" && window.devicePixelRatio) ? window.devicePixelRatio : 2;
					postJson(LIVE_PATH + "/viewport", { width: w, height: h, dpr: dpr });
				}
				sync();
				var ro = new ResizeObserver(sync);
				ro.observe(box);
				return function () { ro.disconnect(); };
			}, []);

			// Frames arrive PUSHED, over Server-Sent Events. Chrome emits one only
			// when the page actually repaints, so an idle page costs nothing and a
			// busy one is not capped by a poll interval.
			//
			// The previous version polled a full screenshot every 450ms: a JPEG
			// encode per tick whether or not anything had changed, plus stale
			// pixels in between. That is what made this feel like a remote desktop.
			useEffect(function () {
				var es = null, alive = true, lastUrl = null;
				try {
					es = new EventSource(LIVE_PATH + "/stream");
				} catch (e) {
					return;
				}
				es.onmessage = function (ev) {
					if (!alive || !ev.data) return;
					// A data: URL avoids a blob allocation per frame at this rate.
					setSrc("data:image/jpeg;base64," + ev.data);
				};
				es.onerror = function () {
					// EventSource reconnects on its own using the server's retry hint.
				};
				return function () {
					alive = false;
					try { es.close(); } catch (e) { /* ignore */ }
					if (lastUrl) URL.revokeObjectURL(lastUrl);
				};
			}, []);

			/** Pane pixel -> page pixel. */
			function at(e) {
				var img = imgRef.current;
				if (!img) return { x: 0, y: 0 };
				var r = img.getBoundingClientRect();
				var sx = sizeRef.current.w / (r.width || 1);
				var sy = sizeRef.current.h / (r.height || 1);
				return { x: Math.round((e.clientX - r.left) * sx), y: Math.round((e.clientY - r.top) * sy) };
			}

			function send(kind, extra) {
				postJson(LIVE_PATH + "/input", Object.assign({ kind: kind }, extra));
			}

			return h("div", {
				ref: boxRef,
				tabIndex: 0,
				style: { position: "relative", width: "100%", height: "100%", background: "#fff", outline: "none", overflow: "hidden" },
				onMouseDown: function (e) { e.preventDefault(); boxRef.current && boxRef.current.focus(); var p = at(e); send("down", { x: p.x, y: p.y, clickCount: e.detail || 1 }); },
				onMouseUp: function (e) { var p = at(e); send("up", { x: p.x, y: p.y, clickCount: e.detail || 1 }); },
				onMouseMove: function (e) { if (e.buttons) { var p = at(e); send("move", { x: p.x, y: p.y }); } },
				onWheel: function (e) { var p = at(e); send("wheel", { x: p.x, y: p.y, deltaY: e.deltaY }); },
				onKeyDown: function (e) {
					// Printable characters go through insertText so IME and shifted
					// symbols behave; everything else is a raw key event.
					if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
						e.preventDefault();
						send("text", { text: e.key });
						return;
					}
					var named = { Enter: 13, Backspace: 8, Tab: 9, Escape: 27, Delete: 46,
						ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35 };
					if (named[e.key]) {
						e.preventDefault();
						send("key", { event: { key: e.key, code: e.code, windowsVirtualKeyCode: named[e.key], nativeVirtualKeyCode: named[e.key] } });
					}
				}
			},
				src
					? h("img", { ref: imgRef, src: src, draggable: false,
						style: { width: "100%", height: "100%", objectFit: "fill", imageRendering: "auto", display: "block", userSelect: "none" } })
					: h("div", { style: { padding: 20, color: "#7d8592", fontSize: 12.5 } }, "Starting the browser…")
			);
		}

		// ── the pane ─────────────────────────────────────────────────────────

		function PreviewOverlay() {
			var openState = useState(false); var open = openState[0], setOpen = openState[1];
			var tabsState = useState([]); var tabs = tabsState[0], setTabs = tabsState[1];
			var activeState = useState(null); var activeId = activeState[0], setActiveId = activeState[1];
			var widthState = useState(readWidth); var width = widthState[0], setWidth = widthState[1];
			var busyState = useState(false); var busy = busyState[0], setBusy = busyState[1];
			var addrState = useState(""); var addr = addrState[0], setAddr = addrState[1];
			var editingState = useState(false); var editing = editingState[0], setEditing = editingState[1];

			var frameRef = useRef(null);
			var addrRef = useRef(null);
			// The live <webview>, when running inside the desktop shell.
			var webviewRef = useRef(null);

			// Mirrors of the render state. The command loop mounts once, so a
			// callback closing over `tabs`/`activeId` would read first-render
			// values forever -- refs are what let a push right after navigation
			// see the tab it just created.
			var tabsRef = useRef(tabs);
			var activeRef = useRef(activeId);
			var openRef = useRef(open);
			// So a page navigating itself does not overwrite a url the human is
			// halfway through typing.
			var editingRef = useRef(false);
			// url -> extracted text, for cross-origin pages we must not refetch
			// on every tick.
			var textCache = useRef({});

			useEffect(function () { tabsRef.current = tabs; }, [tabs]);
			useEffect(function () { activeRef.current = activeId; }, [activeId]);
			useEffect(function () { openRef.current = open; }, [open]);
			useEffect(function () { editingRef.current = editing; }, [editing]);

			// Keep the address bar in step unless the user is typing in it.
			useEffect(function () {
				if (editing) return;
				var t = (tabsRef.current || []).find(function (x) { return x.id === activeId; });
				setAddr(displayUrl(t));
			}, [activeId, tabs, editing]);

			var tabOf = useCallback(function (id) {
				return (tabsRef.current || []).find(function (t) { return t.id === id; }) || null;
			}, []);

			/**
			 * Extract the active tab's text.
			 * @param force re-read cross-origin even if cached (used on navigate/reload)
			 */
			var readTabText = useCallback(function (tab, force) {
				return new Promise(function (resolve) {
					// In the shell, a live tab is a real <webview>. Its DOM is
					// reachable through executeJavaScript, so the pane can push
					// genuine rendered text for pages the host has no CDP
					// connection to -- which is how read_preview works here.
					var wv = webviewRef.current;
					if (tab && tab.live && wv) {
						var done = false;
						var finish = function (text, via) {
							if (done) return;
							done = true;
							resolve({ text: collapse(text || ""), via: via });
						};
						// A webview that is still attaching rejects, and a page
						// mid-navigation can hang; neither should stall the push.
						setTimeout(function () { finish("", "pending"); }, 1500);
						try {
							wv.executeJavaScript("document.body ? document.body.innerText : ''")
								.then(function (t) { finish(t, "webview-dom"); })
								.catch(function () { finish("", "pending"); });
						} catch (e) { finish("", "pending"); }
						return;
					}
					// A live tab outside the shell is a CDP stream: the host reads
					// its text over CDP itself (read_preview), and the site is
					// cross-origin to this page, so a direct fetch would only fail
					// on CORS. Push no text and let the host answer.
					if (tab && tab.live) { resolve({ text: "", via: "cdp" }); return; }
					var doc = frameDocument(frameRef.current);
					if (doc && doc.body && typeof doc.body.innerText !== "undefined") {
						resolve({ text: collapse(doc.body.innerText || doc.body.textContent || ""), via: "live-dom" });
						return;
					}
					// A proxied site is now sandboxed without allow-same-origin, so its
					// DOM is opaque to us. Its URL is one of OUR routes though, so
					// fetching it here is a same-origin request that succeeds.
					var url = tab && tab.url;
					var fetchable = !!url && (/^https?:/i.test(url) || url.charAt(0) === "/");
					if (!fetchable) { resolve({ text: "", via: "none" }); return; }
					if (!force && typeof textCache.current[url] === "string") {
						resolve({ text: textCache.current[url], via: "cache" });
						return;
					}
					fetch(url, { cache: "no-store" })
						.then(function (r) { return r.text(); })
						.then(function (html) {
							var t = htmlToText(html);
							textCache.current[url] = t;
							resolve({ text: t, via: "html" });
						})
						.catch(function () { resolve({ text: "", via: "none" }); });
				});
			}, []);

			var pushState = useCallback(function (force) {
				var tab = tabOf(activeRef.current);
				if (!tab || !openRef.current) { postJson(STATE_PATH, { opened: openRef.current }); return; }
				readTabText(tab, force).then(function (out) {
					// In the shell the pane OWNS the browser, so it must also be
					// the authority on where that browser actually is: a redirect
					// or a link click moves the webview without going through
					// `navigate`, and pushing the tab's original url would report
					// the wrong page for text that is genuinely current.
					var url = tab.url, title = tab.title;
					if (tab.live && webviewRef.current) {
						url = safeUrl(webviewRef.current) || tab.url;
						try { title = webviewRef.current.getTitle() || title; } catch (e) { /* not ready */ }
					}
					postJson(STATE_PATH, {
						tabId: tab.id, url: url, title: title, text: out.text, opened: true,
						// Tells the host the pane is the source of truth for live
						// tabs, so read_preview does not go asking a CDP browser
						// that is not driving this pane.
						mode: (IS_SHELL && tab.live) ? "webview" : "stream"
					});
					setBusy(false);
				});
			}, [tabOf, readTabText]);

			var navigate = useCallback(function (rawUrl, tabId, label, filePath, siteUrl) {
				var url = rawUrl || "";
				if (!url) return;
				var id = tabId || ("tab-" + Date.now());
				setBusy(true);
				setTabs(function (prev) {
					var exists = prev.some(function (t) { return t.id === id; });
					var title = label || siteUrl || filePath || url;
					if (exists) {
						return prev.map(function (t) {
							return t.id === id
								? Object.assign({}, t, { url: url, title: title, filePath: filePath, siteUrl: siteUrl })
								: t;
						});
					}
					return prev.concat([{ id: id, url: url, title: title, filePath: filePath, siteUrl: siteUrl }]);
				});
				setActiveId(id);
				setOpen(true);
				// Drop any blank placeholders now that a real page has a tab.
				setTabs(function (prev) {
					return prev.filter(function (t) { return !t.blank || t.id === id; });
				});
				// The refs update on the next commit; push after it so the tab exists.
				setTimeout(function () { pushState(true); }, 900);
			}, [pushState]);

			var closeTab = useCallback(function (cid) {
				setTabs(function (prev) {
					var next = prev.filter(function (t) { return t.id !== cid; });
					if (next.length === 0) setOpen(false);
					return next;
				});
				setActiveId(function (a) {
					if (a !== cid) return a;
					var rest = (tabsRef.current || []).filter(function (t) { return t.id !== cid; });
					return rest.length ? rest[rest.length - 1].id : null;
				});
				setTimeout(function () { pushState(false); }, 200);
			}, [pushState]);

			var handleCommand = useCallback(function (cmd) {
				if (!cmd || typeof cmd !== "object") return;
				if (cmd.action === "navigate") {
					if (cmd.siteUrl) {
						// In the shell the pane has its own browser, so there is
						// no separate Chrome to launch -- hand the url straight to
						// the webview.
						if (IS_SHELL) { navigateLive(cmd.siteUrl, cmd.label || cmd.siteUrl, cmd.tabId); return; }
						postJson(LIVE_PATH + "/open", { url: cmd.siteUrl }).then(function (st) {
							if (st && st.ok) navigateLive(cmd.siteUrl, st.title);
							else navigate(cmd.url, cmd.tabId, cmd.label, cmd.filePath, cmd.siteUrl);
						});
					} else {
						navigate(cmd.url, cmd.tabId, cmd.label, cmd.filePath, cmd.siteUrl);
					}
				}
				else if (cmd.action === "close-tab") closeTab(cmd.tabId);
				else if (cmd.action === "close-all") {
					setTabs([]); setActiveId(null); setOpen(false);
					setTimeout(function () { pushState(false); }, 200);
				}
			}, [navigate, closeTab, pushState]);

			var handleRef = useRef(handleCommand);
			useEffect(function () { handleRef.current = handleCommand; }, [handleCommand]);

			// Command loop. Mounted once; dispatches through a ref so it always
			// runs the current handler rather than the first-render closure.
			useEffect(function () {
				var alive = true, timer = null;
				function loop() {
					pollCommands().then(function (commands) {
						if (!alive) return;
						for (var i = 0; i < commands.length; i++) {
							try { handleRef.current(commands[i]); } catch (e) { /* keep polling */ }
						}
						timer = setTimeout(loop, COMMAND_POLL_MS);
					});
				}
				loop();
				return function () { alive = false; if (timer) clearTimeout(timer); };
			}, []);

			// Live push. Only cheap for same-origin frames, so cross-origin uses
			// the cache and is refreshed on navigate/reload instead.
			useEffect(function () {
				if (!open) return;
				var t = setInterval(function () { pushState(false); }, LIVE_PUSH_MS);
				return function () { clearInterval(t); };
			}, [open, pushState]);

			// Clicking a link or a file path in the CHAT opens it here rather than
			// throwing the user out to the OS browser. Capture phase, because the
			// app's own handlers would otherwise win.
			useEffect(function () {
				function isOurs(node) {
					// Never hijack clicks inside the pane itself (tabs, address bar).
					return !!(node && node.closest && node.closest("[data-dsh-preview]"));
				}
				function looksLikePath(t) {
					var v = String(t || "").trim();
					if (v.length < 4 || v.length > 400 || /\s{2,}/.test(v)) return false;
					return /^[a-zA-Z]:[\\/]/.test(v) || /^\\\\/.test(v) || /^\//.test(v) || /^file:/i.test(v);
				}
				function onClick(e) {
					var t = e.target;
					if (!t || !t.closest || isOurs(t)) return;

					var a = t.closest("a[href]");
					if (a) {
						var href = a.getAttribute("href") || "";
						if (/^(#|javascript:|mailto:|tel:)/i.test(href)) return;
						// Only external/absolute links -- in-app routing stays untouched.
						if (!/^https?:\/\//i.test(href)) return;
						e.preventDefault();
						e.stopPropagation();
						openRefFn.current(href);
						return;
					}

					// A code span or cell holding an absolute path is the way file
					// names actually appear in this UI.
					var code = t.closest("code, .path, td, span");
					if (code && looksLikePath(code.textContent)) {
						e.preventDefault();
						e.stopPropagation();
						openRefFn.current(code.textContent.trim());
					}
				}
				document.addEventListener("click", onClick, true);
				return function () { document.removeEventListener("click", onClick, true); };
			}, []);

			// Hold the reserved track. The layout package rewrites the frame's
			// inline grid-template on its own re-renders (a sidebar toggle wipes
			// it), so an observer re-applies ours instead of losing the space.
			var railState = useState(false); var railed = railState[0], setRailed = railState[1];
			var frameTopState = useState(PANE_TOP); var frameTop = frameTopState[0], setFrameTop = frameTopState[1];

			useEffect(function () {
				if (!open) { releaseRail(); setRailed(false); return; }

				var ok = reserveRail(width);
				setRailed(ok);
				if (!ok) return;   // shell shape unknown -> stay floating

				var frame = findFrame();
				function syncTop() {
					if (!frame) return;
					var r = frame.getBoundingClientRect();
					setFrameTop(Math.max(0, Math.round(r.top)));
				}
				syncTop();

				var reapplying = false;
				var observer = new MutationObserver(function () {
					if (reapplying) return;
					var current = frame.style.gridTemplateColumns || "";
					var track = frame.getAttribute(RAIL_ATTR);
					if (track && current.endsWith(" " + track)) return;  // still ours
					reapplying = true;
					reserveRail(width);
					syncTop();
					// Let the write we just made settle before listening again,
					// otherwise the observer retriggers on its own mutation.
					setTimeout(function () { reapplying = false; }, 0);
				});
				observer.observe(frame, { attributes: true, attributeFilter: ["style"] });
				window.addEventListener("resize", syncTop);

				return function () {
					observer.disconnect();
					window.removeEventListener("resize", syncTop);
					releaseRail();
				};
			}, [open, width]);

			// Drag-to-resize from the pane's left edge.
			var dragRef = useRef(null);
			useEffect(function () {
				function move(e) {
					if (dragRef.current === null) return;
					var next = Math.min(MAX_W, Math.max(MIN_W, window.innerWidth - e.clientX - 8));
					setWidth(next);
				}
				function up() {
					if (dragRef.current === null) return;
					dragRef.current = null;
					document.body.style.userSelect = "";
					try { window.localStorage.setItem(WIDTH_KEY, String(widthRef.current)); } catch (e) { /* ignore */ }
				}
				window.addEventListener("mousemove", move);
				window.addEventListener("mouseup", up);
				return function () {
					window.removeEventListener("mousemove", move);
					window.removeEventListener("mouseup", up);
				};
			}, []);
			var widthRef = useRef(width);
			useEffect(function () { widthRef.current = width; }, [width]);

			/**
			 * Resolve a raw target through the HOST and show it.
			 * The host owns normalization (file -> served path, site -> proxy), so
			 * the pane never has to duplicate that logic and the two cannot drift.
			 */
			var openTarget = useCallback(function (raw) {
				var v = String(raw || "").trim();
				if (!v) return;
				postJson("/api/preview/open", { url: v }).then(function (r) {
					if (!r || !r.url) return;
					// A web page goes to the real browser: it can be logged in, and
					// it works on sites that refuse to be framed. Local files stay
					// on the file route, which renders them properly.
					if (r.siteUrl) {
						if (IS_SHELL) { navigateLive(r.siteUrl, r.label || r.siteUrl, r.tabId); return; }
						setBusy(true);
						postJson(LIVE_PATH + "/open", { url: r.siteUrl }).then(function (st) {
							setBusy(false);
							if (st && st.ok) navigateLive(r.siteUrl, st.title);
							else navigate(r.url, r.tabId, r.label, r.filePath, r.siteUrl);  // fall back to the proxy
						});
						return;
					}
					navigate(r.url, r.tabId, r.label, r.filePath, r.siteUrl);
				});
			}, [navigate]);

			/** Show a page in the live browser under its own tab. */
			/**
			 * Show a page in the live view under its own tab.
			 *
			 * @param tabId the id the HOST already gave this tab. Use it when we
			 *   have it, because the host looks its pushed state up BY id: a tab
			 *   the pane calls something else is a tab the host cannot find, so
			 *   read_preview falls through to the CDP browser -- which in shell
			 *   mode is driving nothing, and answers with a url and no text.
			 *   That mismatch is exactly how "the page is open but has rendered
			 *   no text yet" gets returned for a page that is plainly rendered.
			 */
			var navigateLive = useCallback(function (siteUrl, title, tabId) {
				var id = tabId || "live";
				setTabs(function (prev) {
					// One live view at a time, whatever it happens to be called,
					// so a changing id cannot leave stale live tabs in the strip.
					var rest = prev.filter(function (t) { return !t.live && !t.blank && t.id !== id; });
					return rest.concat([{ id: id, url: siteUrl, siteUrl: siteUrl, title: title || siteUrl, live: true }]);
				});
				setActiveId(id);
				setOpen(true);
			}, []);

			var openRefFn = useRef(openTarget);
			useEffect(function () { openRefFn.current = openTarget; }, [openTarget]);

			function submitAddr(e) {
				if (e) e.preventDefault();
				var v = String(addr || "").trim();
				if (!v) return;
				setEditing(false);
				openTarget(v);
			}

			/**
			 * Open an empty tab and put the cursor in the address bar.
			 * The tab carries no url, so the viewport shows the empty state until
			 * something is typed -- and navigating from here replaces this blank
			 * placeholder rather than leaving it stranded in the strip.
			 */
			var newTab = useCallback(function () {
				var id = "blank-" + Date.now();
				setTabs(function (prev) { return prev.concat([{ id: id, url: "", title: "New tab", blank: true }]); });
				setActiveId(id);
				setOpen(true);
				setAddr("");
				setEditing(false);
				setTimeout(function () { if (addrRef.current) addrRef.current.focus(); }, 60);
			}, []);

			/**
			 * Save the file on screen to the machine the human is sitting at.
			 *
			 * The host serves it with Content-Disposition: attachment, so the
			 * browser writes it instead of displaying it. An anchor click is
			 * used rather than assigning location, which would navigate the
			 * pane away from the file before the download started.
			 *
			 * This is the only route a file has to the human when the harness
			 * is on another machine -- the file itself never leaves that box
			 * otherwise.
			 */
			function downloadActive() {
				var t = tabOf(activeId);
				if (!t || !t.filePath || !t.url) return;
				var sep = t.url.indexOf("?") === -1 ? "?" : "&";
				var a = document.createElement("a");
				a.href = t.url + sep + "dl=1";
				// The server's header names the file; this is only a hint for
				// clients that ignore it.
				a.download = "";
				a.style.display = "none";
				document.body.appendChild(a);
				a.click();
				setTimeout(function () { try { a.remove(); } catch (e) { /* gone */ } }, 0);
			}

			function reload() {
				var tab = tabOf(activeId);
				if (!tab) return;
				if (tab.live && IS_SHELL && webviewRef.current) {
					try { webviewRef.current.reload(); } catch (e) { /* not ready */ }
					return;  // did-stop-loading clears the spinner and pushes text
				}
				if (tab.live) { setBusy(true); postJson(LIVE_PATH + "/reload", {}).then(function () { setBusy(false); }); return; }
				setBusy(true);
				var frame = frameRef.current;
				if (frame) { try { frame.src = tab.url; } catch (e) { /* ignore */ } }
				setTimeout(function () { pushState(true); }, 900);
			}

			// ── render ────────────────────────────────────────────────────────
			// The toggle is always mounted, so it reads as a persistent control
			// rather than something that vanishes once used. While the pane holds
			// a layout track it shifts left by that width, keeping it at the
			// bottom-right of the CONVERSATION instead of floating over the pane.
			var toggle = h("button", {
				key: "toggle",
				onClick: function () { setOpen(function (v) { return !v; }); },
				title: open ? "Hide browser (currently open)" : "Show browser",
				"data-dsh-preview": "1",
				style: launcherStyle(open, railed ? width : 0)
			},
				h("span", { style: dotStyle(open) }),
				"Browser"
			);

			if (!open) return toggle;

			var activeTab = tabOf(activeId);

			return h(react.Fragment, null, toggle, h("div", { style: paneStyle(width, railed, frameTop), "data-dsh-preview": "1" },
				// resize grip
				h("div", {
					onMouseDown: function () { dragRef.current = 1; document.body.style.userSelect = "none"; },
					title: "Drag to resize",
					style: gripStyle
				}),

				// header
				h("div", { style: headerStyle },
					h("span", { style: { fontWeight: 620, fontSize: 12.5, letterSpacing: .2, opacity: .9 } }, "Browser"),
					h("div", { style: { display: "flex", gap: 2, alignItems: "center" } },
						// Only for files: "download" of a live web page is not a
						// meaningful action, and a button that does nothing is
						// worse than no button.
						(activeTab && activeTab.filePath)
							? h("button", {
								onClick: downloadActive,
								title: "Save this file to your computer",
								style: iconBtn
							}, "↓")
							: null,
						h("button", { onClick: reload, title: "Reload", style: iconBtn }, "↻"),
						h("button", {
							onClick: function () {
								var t = tabOf(activeId);
								var real = t && (t.siteUrl || t.url);
								if (real && /^https?:/i.test(real)) window.open(real, "_blank", "noreferrer");
							},
							title: "Open in your own browser", style: iconBtn
						}, "↗"),
						h("button", { onClick: function () { setOpen(false); }, title: "Close pane", style: iconBtn }, "✕")
					)
				),

				// address bar
				h("form", { onSubmit: submitAddr, style: addrWrapStyle },
					h("input", {
						ref: addrRef,
						value: addr,
						spellCheck: false,
						placeholder: "url or file path…",
						onChange: function (e) { setEditing(true); setAddr(e.target.value); },
						onBlur: function () { setEditing(false); },
						style: addrInputStyle
					}),
					busy ? h("span", { style: spinnerStyle, title: "Loading" }, "●") : null
				),

				// tabs
				h("div", { style: tabStripStyle },
					tabs.map(function (tab) {
						var active = tab.id === activeId;
						return h("div", {
							key: tab.id, title: displayUrl(tab) || "New tab",
							onClick: function () { setActiveId(tab.id); },
							style: Object.assign({}, tabStyle, active ? tabActiveStyle : {})
						},
							h("span", { style: tabLabelStyle }, shortLabel(tab)),
							h("button", {
								onClick: function (e) { e.stopPropagation(); closeTab(tab.id); },
								style: closeXStyle, title: "Close tab"
							}, "×")
						);
					}).concat([
						h("button", {
							key: "new-tab",
							onClick: newTab,
							title: "New tab",
							style: newTabStyle
						}, "+")
					])
				),

				// viewport
				h("div", { style: { flex: 1, position: "relative", minHeight: 0, background: "#fff" } },
					(activeTab && activeTab.live)
						// Inside the shell this is a real embedded browser; in a
						// plain tab it is a mirror of one. Same tab, same tools,
						// same address bar -- only the surface differs.
						? (IS_SHELL
							? h(ShellView, {
								key: "shell",
								url: activeTab.url,
								viewRef: webviewRef,
								onLoading: setBusy,
								onNav: function (u, t) {
									if (!u) return;
									setTabs(function (prev) {
										return prev.map(function (x) {
											return x.id === "live" ? Object.assign({}, x, { url: u, siteUrl: u, title: t || x.title }) : x;
										});
									});
									if (!editingRef.current) setAddr(u);
								}
							})
							: h(LiveView, { key: "live" }))
						: (activeTab && activeTab.url)
						? h("iframe", Object.assign({
							ref: frameRef,
							src: activeTab.url,
							style: frameStyle,
							onLoad: function () { setTimeout(function () { pushState(true); }, 350); }
						}, frameSandbox(activeTab)))
						: h("div", { style: emptyStyle },
							h("div", { style: { fontSize: 26, opacity: .25, marginBottom: 10 } }, "▦"),
							h("div", { style: { fontWeight: 600, marginBottom: 6, color: "#c7ccd4" } }, "Nothing open"),
							h("div", null, "Type a URL or file path above, or ask the agent to ",
								h("code", { style: codeStyle }, "open_preview"), ".")
						)
				)
			));
		}

		/** Tab label: basename for files, hostname for pages. */
		function shortLabel(tab) {
			if (!tab) return "";
			if (tab.blank || !tab.url) return "New tab";
			if (tab.filePath) {
				var parts = String(tab.filePath).split(/[\\/]/);
				return parts[parts.length - 1] || tab.filePath;
			}
			var forLabel = tab.siteUrl || tab.url;
			try { return new URL(forLabel, window.location.origin).hostname || tab.title || forLabel; }
			catch (e) { return tab.title || forLabel; }
		}

		/**
		 * Sandbox policy, which differs by WHAT is being shown.
		 *
		 * Local files: no sandbox. It is our own content served by our own host,
		 * so sandboxing buys nothing -- and it costs something real: Chrome
		 * refuses to run its built-in PDF viewer inside a sandboxed frame, so a
		 * sandboxed .pdf renders as a blank pane.
		 *
		 * Proxied websites: sandboxed WITHOUT allow-same-origin. This matters.
		 * Everything the pane shows is served from the harness's own origin, so
		 * `allow-scripts` + `allow-same-origin` together would let an arbitrary
		 * website's JavaScript reach `parent` and read the app around it. Dropping
		 * allow-same-origin gives the frame an opaque origin, isolating it. Text
		 * extraction still works: the pane fetches the proxy URL itself, which is
		 * same-origin for US, and parses that.
		 */
		function frameSandbox(tab) {
			var isLocalFile = !!(tab && (tab.filePath || /^\/api\/preview\/file/.test(tab.url || "")));
			if (isLocalFile) return {};
			return { sandbox: "allow-scripts allow-forms allow-popups" };
		}

		// ── styles ───────────────────────────────────────────────────────────
		var BORDER = "var(--dsw-alias-border-l2, #2b2f37)";
		var BG = "var(--dsw-alias-bg-base, #16181d)";

		/**
		 * Railed: fill the reserved track exactly — flush right, full height, no
		 * rounding or shadow, so it reads as a column of the app rather than a
		 * card floating above it.
		 * Unrailed: the original floating card, used when the shell shape is
		 * unrecognised.
		 */
		function paneStyle(width, railed, frameTop) {
			var common = {
				position: "fixed", width: width, zIndex: 30,
				display: "flex", flexDirection: "column",
				background: BG, overflow: "hidden", pointerEvents: "auto"
			};
			if (railed) {
				return Object.assign(common, {
					top: frameTop, right: 0, bottom: 0,
					borderLeft: "1px solid " + BORDER,
					borderTop: "1px solid " + BORDER
				});
			}
			return Object.assign(common, {
				top: PANE_TOP, right: 8, bottom: 8,
				border: "1px solid " + BORDER, borderRadius: 12,
				boxShadow: "0 12px 40px rgba(0,0,0,.45)"
			});
		}
		var gripStyle = {
			position: "absolute", left: 0, top: 0, bottom: 0, width: 6,
			cursor: "col-resize", zIndex: 2
		};
		var headerStyle = {
			display: "flex", alignItems: "center", justifyContent: "space-between",
			padding: "7px 8px 7px 12px", borderBottom: "1px solid " + BORDER,
			background: "rgba(255,255,255,.03)"
		};
		var iconBtn = {
			border: "1px solid transparent", background: "transparent", color: "#aab1bd",
			borderRadius: 6, width: 24, height: 24, cursor: "pointer", fontSize: 13,
			lineHeight: "22px", padding: 0
		};
		var addrWrapStyle = {
			display: "flex", alignItems: "center", gap: 6, padding: "7px 10px",
			borderBottom: "1px solid " + BORDER
		};
		var addrInputStyle = {
			flex: 1, minWidth: 0, background: "rgba(0,0,0,.28)",
			border: "1px solid " + BORDER, borderRadius: 7, color: "#dfe3e9",
			padding: "5px 9px", fontSize: 11.5, outline: "none",
			fontFamily: 'ui-monospace, "Cascadia Code", Consolas, monospace'
		};
		var spinnerStyle = { color: "#6fb3ff", fontSize: 9, opacity: .9 };
		var tabStripStyle = {
			display: "flex", gap: 4, padding: "6px 8px",
			borderBottom: "1px solid " + BORDER, overflowX: "auto", background: "rgba(0,0,0,.16)"
		};
		var tabStyle = {
			display: "flex", alignItems: "center", gap: 5, maxWidth: 170,
			padding: "3px 8px", borderRadius: 6, fontSize: 11.5, color: "#9aa1ad",
			cursor: "pointer", background: "rgba(0,0,0,.25)", border: "1px solid transparent",
			flex: "0 0 auto"
		};
		var tabActiveStyle = { color: "#fff", background: "rgba(255,255,255,.14)", borderColor: BORDER };
		var tabLabelStyle = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 };
		var newTabStyle = {
			flex: "0 0 auto", border: "1px dashed " + BORDER, background: "transparent",
			color: "#8b929e", borderRadius: 6, width: 24, height: 22, cursor: "pointer",
			fontSize: 14, lineHeight: "18px", padding: 0
		};
		var closeXStyle = {
			border: "none", background: "transparent", color: "#8b929e", cursor: "pointer",
			fontSize: 13, lineHeight: "13px", padding: 0, width: 14, height: 14
		};
		var frameStyle = { width: "100%", height: "100%", border: 0, background: "#fff", display: "block" };
		var emptyStyle = {
			padding: 28, color: "#7d8592", fontSize: 12.5, lineHeight: 1.6,
			display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
			height: "100%", textAlign: "center", background: BG
		};
		var codeStyle = {
			background: "rgba(255,255,255,.08)", borderRadius: 4, padding: "1px 5px",
			fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 11
		};
		function launcherStyle(active, railWidth) {
			return {
				position: "fixed", bottom: 14, right: 14 + (railWidth || 0), zIndex: 31,
				pointerEvents: "auto",
				border: "1px solid " + (active ? "rgba(111,179,255,.55)" : BORDER),
				background: active ? "rgba(111,179,255,.14)" : "var(--dsw-alias-bg-base, #1e2127)",
				color: active ? "#cfe4ff" : "#c7ccd4",
				borderRadius: 999,
				padding: "7px 13px", cursor: "pointer", fontSize: 11.5, fontWeight: 560,
				letterSpacing: .2, boxShadow: "0 4px 16px rgba(0,0,0,.35)",
				display: "flex", alignItems: "center", gap: 7,
				transition: "right .18s ease, background .15s ease, border-color .15s ease"
			};
		}

		/** Small state lamp: filled when the pane is showing. */
		function dotStyle(active) {
			return {
				width: 6, height: 6, borderRadius: 999, display: "inline-block",
				background: active ? "#6fb3ff" : "#5b6472",
				boxShadow: active ? "0 0 6px rgba(111,179,255,.9)" : "none"
			};
		}

		var inject = [ "slots" ];

		function apply(ctx) {
			ctx.slots.inject("shell.overlay", function () {
				return ctx.slots.register({
					name: "shell.overlay",
					id: "preview-browser",
					inject: function () { return {}; }
				}, PreviewOverlay);
			});
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
