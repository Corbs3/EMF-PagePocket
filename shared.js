// Shared between popup and background
const PP_DEFAULTS = { mode: 'full', format: 'pdf', method: 'scroll', quality: 0.85 };

const PP_MILESTONES = [
  { at: 10,  name: 'Pocket Starter' },
  { at: 25,  name: 'Pocket Pro' },
  { at: 100, name: 'Bottomless Pockets' },
  { at: 250, name: 'Pocket Legend' },
];

function ppMilestoneFor(count) {
  let current = null;
  for (const m of PP_MILESTONES) if (count >= m.at) current = m;
  return current;
}
