import { h, ref, watch, onMounted } from "vue";

export default {
  name: "htmlDoc",
  props: ["content","baseUrl","allowScripts"],
  setup(props) {
    const elementRef = ref(null);
    onMounted(() => {
      const element = [elementRef.value];

        const host = element[0];
        host.classList.add("html-doc");

        function render() {
          // The sandbox attribute only takes effect on navigation, so a fresh
          // iframe is the reliable way to apply a changed policy.
          host.innerHTML = "";
          const content = props.content;
          if (typeof content !== "string") return;

          const iframe = document.createElement("iframe");
          iframe.className = "html-doc-frame";
          iframe.setAttribute("title", "Rendered HTML document");
          // Never combine allow-scripts with allow-same-origin.
          const sandbox = ["allow-popups", "allow-popups-to-escape-sandbox"];
          if (props.allowScripts) {
            sandbox.push("allow-scripts", "allow-forms", "allow-modals");
          }
          iframe.setAttribute("sandbox", sandbox.join(" "));
          iframe.setAttribute("referrerpolicy", "no-referrer");
          host.appendChild(iframe);

          let base = "";
          if (props.baseUrl) {
            base =
              '<base href="' +
              props.baseUrl.replace(/&/g, "&amp;").replace(/"/g, "&quot;") +
              '">';
          }
          iframe.srcdoc = base + content;
        }

        watch(() => props.content, render, { immediate: true });
        watch(() => props.baseUrl, render, { immediate: true });
        watch(() => props.allowScripts, render, { immediate: true });

    });
    return () => h("html-doc", { ref: elementRef });
  },
};
