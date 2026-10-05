// Synthetic Confluence storage-format runbook for the editor tests. It copies the
// shapes of a real deployment runbook — local-ids, rowspan'd Date/Time, <time>
// dates, status macros, user mentions, expand drawers with times, an image, a
// nested key/value table, entities — with made-up content.

const HEADER =
  '<tr ac:local-id="r0"><th ac:local-id="c0"><p><strong>Date</strong></p></th><th><p><strong>Time (SGT)</strong></p></th>' +
  '<th><p><strong>Activity</strong></p></th><th><p><strong>Duration</strong></p></th>' +
  '<th><p><strong>Planned Start Time (SGT)</strong></p></th><th><p><strong>Planned End Time (SGT)</strong></p></th>' +
  '<th><p><strong>Status</strong></p></th><th><p><strong>PIC(s)</strong></p></th><th><p><strong>Logbook (screenshots)</strong></p></th></tr>';

const status = (title: string) =>
  `<ac:structured-macro ac:name="status" ac:schema-version="1" ac:macro-id="m-${title}"><ac:parameter ac:name="title">${title}</ac:parameter><ac:parameter ac:name="mixedCase">true</ac:parameter></ac:structured-macro>`;
const user = (id: string) => `<ac:link><ri:user ri:account-id="${id}" ri:local-id="u-${id}" /></ac:link>`;
const drawer = (title: string, body: string) =>
  `<ac:structured-macro ac:name="expand" ac:schema-version="1" ac:macro-id="x-${title}"><ac:parameter ac:name="title">${title}</ac:parameter><ac:rich-text-body>${body}</ac:rich-text-body></ac:structured-macro>`;

export const RUNBOOK_STORAGE =
  '<h2 local-id="h1">Pre-Prod To Do List</h2>' +
  '<table data-table-width="1652" data-layout="center" ac:local-id="t1"><colgroup><col style="width: 145.0px;" /><col style="width: 124.0px;" /></colgroup><tbody>' +
  HEADER +
  '<tr ac:local-id="r1"><td rowspan="2" ac:local-id="d1"><p local-id="p1"><time datetime="2026-10-26" local-id="tm1" /></p></td>' +
  '<td rowspan="2"><p>5:30 PM</p><p local-id="pe" /></td>' +
  '<td><p>GA Real-Time Traffic Monitoring</p></td><td><p>&lt; 5m</p></td><td><p>5:30 PM</p></td><td><p>5:35 PM</p></td>' +
  `<td><p>${status('TODO')}          </p></td><td><p>${user('acc-jubilee')}   </p></td><td><p local-id="lb1" /></td></tr>` +
  '<tr ac:local-id="r2"><td><p>Take CLS/LCP PageSpeed insights “Before” release</p></td><td data-highlight-colour="#ffffff"><p>30m</p></td>' +
  `<td><p>5:30 PM</p></td><td><p>6:00 PM</p></td><td><p>${status('DONE')}</p></td><td><p>${user('acc-jason')}</p></td><td><p /></td></tr>` +
  '</tbody></table>' +
  '<p local-id="gap">&nbsp;</p>' +
  '<h2 local-id="h2">Prod To Do List</h2>' +
  '<table data-layout="center" ac:local-id="t2"><tbody>' +
  HEADER +
  '<tr><td rowspan="3"><p><time datetime="2026-10-26" /></p></td><td><p>6:00 PM</p></td>' +
  '<td><p>GA Real-Time Traffic Monitoring</p><p>during deployment (every 15 mins - max 2 hours)</p></td><td><p>2h</p></td><td><p>6:00 PM</p></td><td><p>8:00 PM</p></td>' +
  `<td><p>${status('TODO')}</p></td><td><p>${user('acc-jubilee')}</p></td>` +
  `<td>${drawer('6:00 PM', '<ac:image ac:align="center" ac:width="760"><ri:attachment ri:filename="ga-1800.png" ri:version-at-save="1" /></ac:image><ul><li><p>Active User - 2764 (+3.44%)</p></li></ul>')}${drawer('6:15 PM', '<p />')}</td></tr>` +
  '<tr><td><p>6:00 PM</p></td><td><p>MSP App Configuration &rarr; adding key-value</p>' +
  '<table><tbody><tr><th><p>Key</p></th><th><p>Value</p></th></tr><tr><td><p>VERIFIED_BADGE_COUNTRIES</p></td><td><p>HK,SG,MY</p></td></tr></tbody></table></td>' +
  `<td><p>3m</p></td><td><p>6:00 PM</p></td><td><p>6:03 PM</p></td><td><p>${status('TODO')}</p></td><td><p>${user('acc-dityo')}</p></td><td><p /></td></tr>` +
  '<tr><td><p>8:50 PM</p><p>(2hrs from start of Testing)</p></td><td><p>Rollback Confirmation&rarr; After QC verification</p></td>' +
  `<td><p>&lt; 15m</p></td><td><p>8:50 PM</p></td><td><p>8:05 PM</p></td><td><p>${status('TBC')}</p></td><td><p>${user('acc-sam')} / ${user('acc-kelvin')}</p></td><td><p /></td></tr>` +
  '</tbody></table>' +
  '<h2>Rollback plan</h2>' +
  '<table><tbody>' +
  HEADER.replace('Planned Start Time', 'Start Time').replace('Planned End Time', 'End Time') +
  '<tr><td data-highlight-colour="#ffffff" rowspan="2"><p><time datetime="2026-10-26" /></p></td><td><p>9:40 PM</p></td><td><p>QC Testing</p></td><td><p>4h</p></td><td><p>9:40 PM</p></td><td><p>1:40 AM</p></td>' +
  `<td><p /></td><td><p>${user('acc-pia')}</p></td><td><p /></td></tr>` +
  '<tr><td><p>9:40 PM</p></td><td><p>Server Health Monitoring (Every 30m)</p></td><td><p>2h</p></td><td><p>9:40 PM</p></td><td><p>11:40 PM</p></td>' +
  `<td><p /></td><td><p>${user('acc-jason')}</p></td><td><p /></td></tr>` +
  '<tr><td><p><time datetime="2026-10-27" /></p></td><td><p>1:40 AM</p></td><td><p>Release Closure</p></td><td><p>&lt; 5m</p></td><td><p>1:40 PM</p></td><td><p>1:45 AM</p></td>' +
  `<td><p /></td><td><p>${user('acc-jason')}</p></td><td><p /></td></tr>` +
  '</tbody></table>' +
  '<p />';
