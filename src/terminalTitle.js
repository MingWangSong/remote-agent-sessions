'use strict';

function terminalTitle(title, usedNames) {
  if (!usedNames.has(title)) return title;
  let index = 2;
  while (usedNames.has(`${title} · ${index}`)) index++;
  return `${title} · ${index}`;
}
function bannerText(value) { return String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, ''); }
module.exports = { terminalTitle, bannerText };
