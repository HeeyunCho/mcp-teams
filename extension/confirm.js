const id = new URLSearchParams(location.search).get("id");
const $ = (s) => document.getElementById(s);

function el(tag, text, className) {
  const e = document.createElement(tag);
  if (text != null) e.textContent = text; // always text, never HTML: content is untrusted
  if (className) e.className = className;
  return e;
}

const KIND = { oneOnOne: "Chat", group: "Group chat", meeting: "Meeting chat", channel: "Channel", self: "Notes to self" };

async function load() {
  const res = await chrome.runtime.sendMessage({ type: "confirm:get", id });
  const main = $("main");
  main.textContent = "";
  if (!res || res.error) {
    main.append(el("p", res?.error ?? "This request has expired."));
    $("send").disabled = true;
    return;
  }
  const r = res.request;
  const dl = el("dl");
  const add = (k, v) => v && dl.append(el("dt", k), el("dd", v));
  add(KIND[r.conversation.kind] ?? "To", r.conversation.title ?? r.conversation.id);
  if (r.conversation.title) add("Id", r.conversation.id);
  add("Subject", r.subject);
  main.append(dl);
  if (r.replyingTo) {
    const who = r.replyingTo.from?.name ? `${r.replyingTo.from.name}: ` : "";
    main.append(el("strong", "In reply to"), el("div", `${who}${(r.replyingTo.text ?? `message ${r.replyingTo.id}`).slice(0, 600)}`, "quote"));
  }
  main.append(el("strong", "Message"), el("pre", r.text));
  $("send").disabled = false;
}

async function decide(approve) {
  $("send").disabled = $("cancel").disabled = true;
  $("status").textContent = approve ? "Sending…" : "";
  const res = await chrome.runtime.sendMessage({ type: "confirm:decide", id, approve });
  if (res && !res.ok) $("status").textContent = res.error;
  // On success the background closes this window.
}

$("send").addEventListener("click", () => decide(true));
$("cancel").addEventListener("click", () => decide(false));
load();
