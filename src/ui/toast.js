export function toast(message, type = 'info', ms = 3800) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.textContent = message;
  host.appendChild(node);
  setTimeout(() => {
    node.classList.add('out');
    setTimeout(() => node.remove(), 300);
  }, ms);
}

export function showLoading(text = 'Working…') {
  document.getElementById('loadingText').textContent = text;
  document.getElementById('loading').hidden = false;
}

export function hideLoading() {
  document.getElementById('loading').hidden = true;
}
