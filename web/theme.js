// Theme resolution + nav toggle. Loaded blocking in <head>, before style.css,
// so data-theme is set before first paint (no flash of the wrong theme).
// Lives outside web/js/ on purpose: it is not verification code, so it stays
// out of the CLI integrity-pinned set.
(function () {
  const KEY = 'trustcam-theme'
  const root = document.documentElement
  const systemLight = window.matchMedia('(prefers-color-scheme: light)')

  // storage can throw (private mode, blocked site data): fall back to system
  function stored () {
    try { return window.localStorage.getItem(KEY) } catch (e) { return null }
  }

  function apply (theme) {
    root.dataset.theme = theme || (systemLight.matches ? 'light' : 'dark')
  }

  apply(stored())
  // follow the OS only while the visitor has not picked a theme explicitly
  systemLight.addEventListener('change', function () {
    if (!stored()) apply()
  })

  document.addEventListener('DOMContentLoaded', function () {
    const nav = document.querySelector('nav')
    if (!nav) return
    const btn = document.createElement('button')
    btn.className = 'theme-toggle'
    btn.type = 'button'

    function label () {
      const next = root.dataset.theme === 'light' ? 'dark' : 'light'
      btn.textContent = next === 'light' ? '☀' : '☾'
      btn.setAttribute('aria-label', 'Switch to ' + next + ' theme')
      btn.title = btn.getAttribute('aria-label')
    }

    btn.addEventListener('click', function () {
      const next = root.dataset.theme === 'light' ? 'dark' : 'light'
      apply(next)
      try { window.localStorage.setItem(KEY, next) } catch (e) {}
      label()
    })
    label()
    nav.appendChild(btn)
  })
})()
