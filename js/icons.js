const ICONS_BASE = new URL("./assets/icons/", import.meta.url);

export const iconUrl = (name) => new URL(`${name}.svg`, ICONS_BASE).href;

export function applyIcon(el, name) {
    el.classList.add("newflow-icon");
    el.style.setProperty("--newflow-icon", `url(${iconUrl(name)})`);
}
