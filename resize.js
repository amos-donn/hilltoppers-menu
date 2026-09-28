// Reports this page's natural content height to the Hilltoppers extension so a
// Topping can be embedded with "Fit content" instead of a fixed height.
//
// Loaded with a deferred script tag. The extension passes `host` (its own
// origin) and `session` on the iframe URL, then posts a `context` message with
// the chosen height mode. We only report while that mode is `content`.
(() => {
  const params = new URLSearchParams(location.search);
  const host = params.get('host');
  const session = params.get('session');
  const content = document.querySelector('[data-topping-content]');
  if (!host || !session || !content || parent === window) return;

  let enabled = false;
  let frame = 0;
  let lastHeight = 0;

  function schedule() {
    if (!enabled || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      // Measure the natural-height wrapper rather than document.scrollHeight:
      // the latter includes the iframe viewport, so the page could grow but
      // never shrink back.
      const bounds = content.getBoundingClientRect();
      const body = getComputedStyle(document.body);
      const height = Math.ceil(
        bounds.bottom +
          window.scrollY +
          (parseFloat(body.paddingBottom) || 0) +
          (parseFloat(body.marginBottom) || 0)
      );
      if (height <= 0 || height === lastHeight) return;
      lastHeight = height;
      parent.postMessage(
        { channel: 'hilltoppers-topping-v1', session, type: 'resize', height },
        host
      );
    });
  }

  new ResizeObserver(schedule).observe(content);

  window.addEventListener('message', (event) => {
    if (event.source !== parent || event.origin !== host) return;
    const data = event.data;
    if (
      data?.channel !== 'hilltoppers-topping-v1' ||
      data.session !== session ||
      data.type !== 'context'
    ) {
      return;
    }
    enabled = data.heightMode === 'content';
    schedule();
  });

  window.addEventListener('resize', schedule);
})();
