// Small pieces the shared player and a Satellite's own pages both draw: the like button and
// the quality badge. Likes come from the provider's audio.session; without it, no button.
import * as session from "./session.js";
import { el, iconButton } from "./dom.js";

session.on("favorites", () => {
    for (const node of document.querySelectorAll("[data-like-kind]")) {
        const liked = session.isLiked(node.dataset.likeKind, node.dataset.likeId);
        node.classList.toggle("liked", liked);
        node.setAttribute("aria-pressed", String(liked));
    }
});

export function likeButton(kind, id, label = "Like") {
    const node = iconButton("heart", label, () => session.toggleLiked(kind, id).catch((error) => session.toast(error.message, "error")), "mu-icon-button mu-like");
    node.dataset.likeKind = kind;
    node.dataset.likeId = id;
    node.hidden = !session.offersLikes();
    const liked = session.isLiked(kind, id);
    node.classList.toggle("liked", liked);
    node.setAttribute("aria-pressed", String(liked));
    return node;
}

export function qualityBadge(quality) {
    if (!quality || !(quality.lossless || quality.hires)) {
        return null;
    }
    const node = el("span", `mu-badge ${quality.hires ? "mu-badge-hires" : "mu-badge-lossless"}`, quality.hires ? "Hi-Res" : "Lossless");
    node.title = quality.label;
    return node;
}
