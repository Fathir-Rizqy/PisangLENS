export function initializeDashboard() {
    const sections = [...document.querySelectorAll('[data-dashboard-section]')];
    const links = [...document.querySelectorAll('.dashboard-nav a')];
    function navigate() {
        const requested = location.hash.slice(1);
        const active = sections.find(section => section.id === requested) ?? sections[0];
        for (const section of sections) section.hidden = section !== active;
        for (const link of links) {
            if (link.hash === '#' + active.id) link.setAttribute('aria-current', 'page');
            else link.removeAttribute('aria-current');
        }
        document.querySelector('#dashboard-title').textContent = active.dataset.title;
    }
    window.addEventListener('hashchange', navigate);
    navigate();
}
