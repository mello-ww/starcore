// The Status page's charts, meters and sparklines are Mission Control's
// shared chart components now (mission_control/ui/charts.js), which the UI
// contract renderer uses too. This module keeps page.js's import working.
export { createChart, meter, niceMaximum, segments, sparkline } from "/ui/charts.js";
