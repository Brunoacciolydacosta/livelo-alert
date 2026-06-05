require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

function parseUser(row) {
  if (!row) return null;
  return {
    ...row,
    // Supabase retorna arrays nativamente; fallback para JSON string se necessário
    categories: Array.isArray(row.categories)
      ? row.categories
      : JSON.parse(row.categories || '[]'),
    favorite_stores: Array.isArray(row.favorite_stores)
      ? row.favorite_stores
      : JSON.parse(row.favorite_stores || '[]'),
  };
}

// ─── USERS ────────────────────────────────────────────────────────────────────

async function upsertUser({ phone, categories, favoriteStores, frequency, dayOfWeek, sendHour, userId, minPointsThreshold, maxStoresPerMessage }) {
  const row = {
    phone,
    categories:             categories            ?? [],
    favorite_stores:        favoriteStores         ?? [],
    frequency:              frequency              ?? 'daily',
    day_of_week:            dayOfWeek              ?? null,
    send_hour:              sendHour               ?? 8,
    min_points_threshold:   minPointsThreshold     ?? null,
    max_stores_per_message: maxStoresPerMessage    ?? 10,
  };
  if (userId) row.user_id = userId;

  const { data, error } = await supabase
    .from('users')
    .upsert(row, { onConflict: 'phone' })
    .select()
    .single();

  if (error) throw new Error(error.message);
  return parseUser(data);
}

async function getUserByUserId(userId) {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return parseUser(data);
}

async function getUserByPhone(phone) {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('phone', phone)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return parseUser(data);
}

async function getAllActiveUsers() {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('active', true);

  if (error) throw new Error(error.message);
  return (data || []).map(parseUser);
}

async function deleteUser(phone) {
  const { error } = await supabase
    .from('users')
    .delete()
    .eq('phone', phone);

  if (error) throw new Error(error.message);
}

async function setUserActive(userId, active) {
  const { error } = await supabase
    .from('users')
    .update({ active })
    .eq('user_id', userId);

  if (error) throw new Error(error.message);
}

async function markUserNotified(phone) {
  const { error } = await supabase
    .from('users')
    .update({ last_notified_at: new Date().toISOString() })
    .eq('phone', phone);

  if (error) throw new Error(error.message);
}

// ─── PROMOTIONS ───────────────────────────────────────────────────────────────

async function savePromotions(promotions) {
  if (promotions.length === 0) return 0;

  const rows = promotions.map(p => ({
    store:         p.store,
    category:      p.category,
    title:         p.title,
    description:   p.description   ?? null,
    coupon:        p.coupon        ?? null,
    credit_term:   p.credit_term   ?? null,
    journey_type:  p.journey_type  ?? null,
    points_per_real: p.points_per_real ?? null,
    multiplier:    p.multiplier    ?? null,
    url:           p.url           ?? null,
    image_url:     p.image_url     ?? null,
    valid_until:   p.valid_until   ?? null,
  }));

  const { data, error } = await supabase
    .from('promotions')
    .insert(rows, { ignoreDuplicates: true })
    .select();

  if (error) throw new Error(error.message);
  return data?.length ?? 0;
}

function todayRange() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + 86400000);
  return { start: start.toISOString(), end: end.toISOString() };
}

async function getPromotionsForUser(user) {
  const { start, end } = todayRange();

  const { data, error } = await supabase
    .from('promotions')
    .select('*')
    .gte('scraped_at', start)
    .lt('scraped_at', end)
    .order('points_per_real', { ascending: false });

  if (error) throw new Error(error.message);

  let promos = data || [];

  if (user.categories.length > 0 || user.favorite_stores.length > 0) {
    promos = promos.filter(p => {
      const matchCategory = user.categories.length === 0 ||
        user.categories.some(c => p.category.toLowerCase().includes(c.toLowerCase()));
      const matchStore = user.favorite_stores.length === 0 ||
        user.favorite_stores.some(s => p.store.toLowerCase().includes(s.toLowerCase()));
      return matchCategory || matchStore;
    });
  }

  return promos;
}

async function getRecentPromotions(limit = 50) {
  const { start, end } = todayRange();

  const { data, error } = await supabase
    .from('promotions')
    .select('*')
    .gte('scraped_at', start)
    .lt('scraped_at', end)
    .order('scraped_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(error.message);
  return data || [];
}

async function getLatestPromotions(limit = 50) {
  // Busca o scraped_at mais recente disponível
  const { data: latest, error: latestErr } = await supabase
    .from('promotions')
    .select('scraped_at')
    .order('scraped_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (latestErr) throw new Error(latestErr.message);
  if (!latest) return [];

  // Retorna todas as promoções daquele scraping (mesmo scraped_at, até o limit)
  const { data, error } = await supabase
    .from('promotions')
    .select('*')
    .gte('scraped_at', latest.scraped_at)
    .order('points_per_real', { ascending: false })
    .limit(limit);

  if (error) throw new Error(error.message);
  return data || [];
}

// ─── LOGS ─────────────────────────────────────────────────────────────────────

async function logNotification({ phone, promotionsSent, success, errorMessage }) {
  const { error } = await supabase
    .from('notification_log')
    .insert({
      user_phone:      phone,
      promotions_sent: promotionsSent,
      success,
      error_message:   errorMessage ?? null,
    });

  if (error) throw new Error(error.message);
}

module.exports = {
  upsertUser,
  getUserByPhone,
  getUserByUserId,
  setUserActive,
  getAllActiveUsers,
  deleteUser,
  markUserNotified,
  savePromotions,
  getPromotionsForUser,
  getRecentPromotions,
  getLatestPromotions,
  logNotification,
};
