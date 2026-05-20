
// ============================================
// REWARDS & GAMIFICATION ENGINE
// ============================================

const LEVELS = [
  { level: 1, name: 'Vart Bronze', nameHi: 'वार्ट ब्रॉन्ज़', minPoints: 0, icon: '🥉', color: '#CD7F32' },
  { level: 2, name: 'Vart Silver', nameHi: 'वार्ट सिल्वर', minPoints: 301, icon: '🥈', color: '#C0C0C0' },
  { level: 3, name: 'Vart Gold', nameHi: 'वार्ट गोल्ड', minPoints: 1001, icon: '🥇', color: '#FFD700' },
  { level: 4, name: 'Vart Platinum', nameHi: 'वार्ट प्लैटिनम', minPoints: 3001, icon: '💎', color: '#E5E4E2' },
  { level: 5, name: 'Vart Diamond', nameHi: 'वार्ट डायमंड', minPoints: 8001, icon: '💍', color: '#B9F2FF' },
  { level: 6, name: 'Vart Legend', nameHi: 'वार्ट लीजेंड', minPoints: 20001, icon: '👑', color: '#EAB308' },
];

const POINT_RULES = {
  registration: { points: 100, description: 'Welcome bonus for registration', once: true },
  profile_complete: { points: 50, description: 'Profile completed', once: true },
  daily_login: { points: 5, description: 'Daily login', daily: true },
  daily_chat: { points: 10, description: 'Daily AI chat', daily: true },
  streak_7: { points: 50, description: '7-day streak bonus', repeatable: true },
  streak_14: { points: 100, description: '14-day streak bonus', repeatable: true },
  streak_30: { points: 250, description: '30-day streak bonus', repeatable: true },
  referral: { points: 200, description: 'Friend registered via your referral', repeatable: true },
  referral_bonus: { points: 50, description: 'Welcome bonus from referral', once: true },
  soil_health_check: { points: 25, description: 'First soil health check', once: true },
  pest_alert_viewed: { points: 15, description: 'First pest alert viewed', once: true },
  community_post: { points: 10, description: 'Posted in community', daily_max: 2 },
};

function getLevel(points) {
  let currentLevel = LEVELS[0];
  for (const level of LEVELS) {
    if (points >= level.minPoints) currentLevel = level;
  }
  return currentLevel;
}

function getNextLevel(points) {
  for (const level of LEVELS) {
    if (points < level.minPoints) return level;
  }
  return null;
}

function generateReferralCode(name) {
  const prefix = (name || 'FARM').substring(0, 4).toUpperCase().replace(/[^A-Z]/g, 'X');
  const suffix = Math.random().toString(36).substring(2, 6).toUpperCase();
  return prefix + suffix;
}

module.exports = { LEVELS, POINT_RULES, getLevel, getNextLevel, generateReferralCode };
