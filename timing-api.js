(function configureTimingApi() {
  "use strict";

  const publishableKey = "sb_publishable_rEY1bSLnKyW4p84tVi4VJQ_Zkic_clr";

  window.timingApiFetch = function timingApiFetch(input, init = {}) {
    const headers = new Headers(init.headers || {});
    headers.set("apikey", publishableKey);
    return fetch(input, { ...init, headers });
  };
})();
