/**
 * CSP 兼容垫片：少数 rc-* 库（如滚动条测量）用 `updateCSS` 动态插入 `<style>`，
 * 但不会传 nonce，导致 nonce 制的 `style-src-elem` 拒绝应用这些样式。
 * 在应用启动前给所有动态注入的 style 节点补上页面 nonce，既不放宽 CSP，
 * 也避免浏览器控制台出现违规告警。必须在任何 React/组件代码之前执行。
 */
const nonce = document.querySelector<HTMLMetaElement>('meta[property="csp-nonce"]')?.nonce;

if (nonce && typeof document.head.appendChild === "function") {
  const stamp = (node: Node) => {
    if (node instanceof HTMLStyleElement && !node.nonce) node.nonce = nonce;
  };

  const head = document.head;
  const appendChild = head.appendChild.bind(head);
  head.appendChild = ((node: Node) => {
    stamp(node);
    return appendChild(node);
  }) as typeof head.appendChild;

  const insertBefore = head.insertBefore.bind(head);
  head.insertBefore = ((node: Node, reference: Node | null) => {
    stamp(node);
    return insertBefore(node, reference);
  }) as typeof head.insertBefore;
}
