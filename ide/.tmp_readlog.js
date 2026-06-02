const fs = require('fs');
const t = fs.readFileSync('C:/Users/VijayRaghavVarada/.theia/gemini-body.log', 'utf8');
const turns = t.split('=====');
console.log('Total turn-segments:', turns.length);
turns.forEach((seg, i) => {
  console.log('\n========= SEGMENT', i, '(len', seg.length, ') =========');
  console.log(seg.substring(0, 2500));
});
