export const createQuotaService = function (http) {
      function decorate(q) {
        q = q || { used: 0, total: 0 };
        q.unlimited = !q.total;
        q.percent = q.unlimited ? 0 : Math.min(100, (q.used * 100) / q.total);
        q.level = q.unlimited
          ? "unlimited"
          : q.percent >= 95
          ? "danger"
          : q.percent >= 80
          ? "warn"
          : "ok";
        return q;
      }
      return {
        decorate: decorate,
        load: function () {
          return http.get("/api/user/quota").then((res) => {
            const quota = res.data || {};
            quota.storage = decorate(quota.storage);
            quota.file = decorate(quota.file);
            quota.repository = decorate(quota.repository);
            return quota;
          });
        },
      };
    };
