// The only script allowed inside an email frame. It reports the content height to the
// app so the frame can be sized without the app ever touching the email's document.
// Allowed by its SHA-256 hash (computed at build time in vite.config.mjs); nothing else runs.
export const FRAME_REPORTER = "(function(){var last=0;function send(){var h=Math.ceil(document.documentElement.getBoundingClientRect().height);if(h!==last){last=h;parent.postMessage({emargyFrameHeight:h},'*');}}new ResizeObserver(send).observe(document.documentElement);addEventListener('load',send);send();})();";
