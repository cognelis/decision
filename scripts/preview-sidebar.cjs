// Layout baselines measure expanded navigation; the app itself starts compact.
exports.expandSidebar = window => window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
  const deadline = Date.now() + 10000;
  const expand = () => {
    const toggle = document.querySelector('[aria-label="展开菜单栏"]');
    if (toggle) {
      toggle.click();
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    } else if (document.querySelector('[aria-label="收起菜单栏"]')) resolve();
    else if (Date.now() >= deadline) reject(new Error('Sidebar did not render'));
    else setTimeout(expand, 16);
  };
  expand();
})`);
