-- ADDITIVE : export JSON du compte (G10 du M6a, D§7.12) — account_export. Nouvelle fonction, rien de redéfini. Idempotente.
-- Compatible pg-safeupdate (préchargé par le PostgREST hébergé, même dans les fonctions) : tout DELETE/UPDATE garde un WHERE.
-- Contenu : les données du joueur et ce qu'il voit déjà (ses messages reçus, ses batailles par battle_json). Jamais : p256dh ni auth des
-- abonnements push, wm.battle_secrets, un signalement reçu, une clé d'idempotence, une ligne d'audit, l'e-mail d'un autre joueur.
-- Droit du joueur : ni maintenance ni restriction ne l'empêchent ; compte supprimé (401), suspension ou bannissement (403) le refusent.
-- Pas de p_idem : rejouer par clé stockerait tout l'export dans wm.idempotency_keys ; la fenêtre de débit (429) tient lieu de garde.
-- Réponse perdue (délai dépassé après le commit) : l'export reste verrouillé pour la fenêtre de 10 minutes ; /privacy (Task 14) doit le dire.
-- shortcut: un seul JSON en une transaction ; au-delà d'environ 4 Mo (environ 15 000 copies), la réponse Vercel échoue : export par section au M8.
create or replace function wm.account_export(p_uid uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_int int := (select (value ->> 'interval_s')::int from wm.config where key = 'account_export');
  v_at timestamptz;
  v_email text;
begin
  perform wm.access_check(p_uid);  -- avant le verrou : une suppression concurrente ne fait que rendre au propriétaire ses propres données (sans risque)
  perform set_config('lock_timeout', '2s', true);
  perform wm.lock_user(p_uid);
  select export_at into v_at from wm.user_state where user_id = p_uid;
  if v_at > now() - make_interval(secs => v_int) then
    perform wm.raise_err(429, null, 'Le site demande de ralentir',
      jsonb_build_object('retry_after', least(v_int, greatest(1, ceil(extract(epoch from v_at + make_interval(secs => v_int) - now()))::int))));
  end if;
  update wm.user_state set export_at = now() where user_id = p_uid;
  select email into v_email from auth.users where id = p_uid;
  return jsonb_build_object(
    'format', 'export-compte', 'version', 1, 'generated_at', now(),
    'account', (select jsonb_build_object('id', p.id, 'email', v_email, 'username', p.username, 'bio', p.bio, 'avatar_url', p.avatar_url,
        'is_public', p.is_public, 'created_at', p.created_at, 'last_seen_at', p.last_seen_at, 'is_pro', p.is_pro, 'is_vip', p.is_vip,
        'pack_cap', p.pack_cap, 'packs_remaining', p.packs_remaining, 'packs_last_regen_at', p.packs_last_regen_at,
        'wikibidous_balance', p.wikibidous_balance) from public.profiles p where p.id = p_uid),
    'state', (select to_jsonb(s) from wm.user_state s where s.user_id = p_uid),
    'stats', (select to_jsonb(s) from wm.user_stats s where s.user_id = p_uid),
    'preferences', (select to_jsonb(s) from wm.user_prefs s where s.user_id = p_uid),
    'notification_prefs', (select to_jsonb(s) from wm.notification_prefs s where s.user_id = p_uid),
    'push_subscriptions', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'endpoint', s.endpoint, 'created_at', s.created_at)
      order by s.created_at, s.id) from public.push_subscriptions s where s.user_id = p_uid), '[]'),
    'notifications', coalesce((select jsonb_agg(to_jsonb(n) order by n.created_at, n.id)
      from public.notifications n where n.user_id = p_uid), '[]'),
    'cards', coalesce((select jsonb_agg(to_jsonb(c) || jsonb_build_object('tags', coalesce((select jsonb_agg(t.name order by t.name, t.id)
        from public.user_card_tags x join public.tags t on t.id = x.tag_id where x.user_card_id = c.id), '[]')) order by c.obtained_at, c.id)
      from public.user_cards c where c.user_id = p_uid), '[]'),
    'tags', coalesce((select jsonb_agg(to_jsonb(t) order by t.created_at, t.id) from public.tags t where t.user_id = p_uid), '[]'),
    'wishlist', coalesce((select jsonb_agg(to_jsonb(w) order by w.created_at, w.card_id)
      from public.wishlist_items w where w.user_id = p_uid), '[]'),
    'showcase', coalesce((select jsonb_agg(to_jsonb(s) order by s.position, s.user_card_id) from public.showcase s where s.user_id = p_uid), '[]'),
    'ledger', coalesce((select jsonb_agg(to_jsonb(l) order by l.created_at, l.id) from wm.wb_ledger l where l.user_id = p_uid), '[]'),
    'auctions_sold', coalesce((select jsonb_agg(to_jsonb(a) - 'snapshot_search_document' order by a.created_at, a.id)
      from public.auctions a where a.seller_id = p_uid), '[]'),
    'bids', coalesce((select jsonb_agg(to_jsonb(b) order by b.placed_at, b.id) from public.auction_bids b where b.bidder_id = p_uid), '[]'),
    'trades', coalesce((select jsonb_agg(to_jsonb(t) || jsonb_build_object('items', coalesce((select jsonb_agg(to_jsonb(i) order by i.id)
        from public.trade_items i where i.trade_id = t.id), '[]')) order by t.created_at, t.id)
      from public.trades t where p_uid in (t.initiator_id, t.recipient_id)), '[]'),
    'friends', coalesce((select jsonb_agg(jsonb_build_object('friendship_id', f.id, 'status', f.status, 'other_username', o.username,
        'created_at', f.created_at) order by f.created_at, f.id)
      from public.friendships f join public.profiles o on o.id = case when f.requester_id = p_uid then f.addressee_id else f.requester_id end
      where p_uid in (f.requester_id, f.addressee_id)), '[]'),
    'messages', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'direction', case when m.sender_id = p_uid then 'sent' else 'received' end,
        'other_username', o.username, 'content', m.content, 'read', m.read, 'created_at', m.created_at) order by m.created_at, m.id)
      from public.chat_messages m join public.profiles o on o.id = case when m.sender_id = p_uid then m.recipient_id else m.sender_id end
      where p_uid in (m.sender_id, m.recipient_id)), '[]'),
    'reports_filed', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'reported_username', o.username, 'reason', r.reason,
        'details', r.details, 'created_at', r.created_at) order by r.created_at, r.id)
      from public.reports r join public.profiles o on o.id = r.reported_user_id where r.reporter_id = p_uid), '[]'),
    'battles', coalesce((select jsonb_agg(wm.battle_json(b, p_uid) || jsonb_build_object('my_deck',
        (select d.card_ids from public.battle_decks d where d.battle_id = b.id and d.user_id = p_uid)) order by b.created_at, b.id)
      from public.battles b where p_uid in (b.challenger_id, b.opponent_id)), '[]'),
    'guild', jsonb_build_object(
      'membership', (select to_jsonb(m) || jsonb_build_object('guild_name', g.name) from public.guild_members m
        join public.guilds g on g.id = m.guild_id where m.user_id = p_uid),
      'wishes', coalesce((select jsonb_agg(to_jsonb(w) order by w.created_at, w.id) from public.guild_wishlists w where w.user_id = p_uid), '[]'),
      'donations_given', coalesce((select jsonb_agg(to_jsonb(d) order by d.created_at, d.id)
        from public.guild_donations d where d.donor_id = p_uid), '[]'),
      'donations_received', coalesce((select jsonb_agg(to_jsonb(d) order by d.created_at, d.id)
        from public.guild_donations d where d.recipient_id = p_uid), '[]'),
      'messages', coalesce((select jsonb_agg(to_jsonb(m) order by m.created_at, m.id)
        from public.guild_chat_messages m where m.user_id = p_uid), '[]'),
      'invites_received', coalesce((select jsonb_agg(jsonb_build_object('guild_id', i.guild_id, 'guild_name', g.name, 'inviter_username', o.username,
          'created_at', i.created_at) order by i.created_at, i.guild_id)
        from wm.guild_invites i join public.guilds g on g.id = i.guild_id left join public.profiles o on o.id = i.inviter_id
        where i.user_id = p_uid), '[]')),
    'achievements', coalesce((select jsonb_agg(to_jsonb(a) order by a.unlocked_at, a.achievement_id)
      from public.user_achievements a where a.user_id = p_uid), '[]'),
    'pro_daily_claims', coalesce((select jsonb_agg(to_jsonb(c) order by c.claimed_at, c.day)
      from wm.pro_daily_claims c where c.user_id = p_uid), '[]'),
    'special_pack_claims', coalesce((select jsonb_agg(to_jsonb(c) order by c.claimed_at, c.pack_id)
      from wm.special_pack_claims c where c.user_id = p_uid), '[]'),
    'grace_grants', coalesce((select jsonb_agg(to_jsonb(g) - 'created_by' order by g.created_at, g.id)
      from wm.grace_grants g where g.user_id = p_uid), '[]'),
    'sanctions', coalesce((select jsonb_agg(jsonb_build_object('kind', s.kind, 'reason', s.reason, 'starts_at', s.starts_at,
        'ends_at', s.ends_at, 'revoked_at', s.revoked_at) order by s.created_at, s.id) from wm.sanctions s where s.user_id = p_uid), '[]'),
    'image_reports', coalesce((select jsonb_agg(jsonb_build_object('card_id', r.card_id, 'created_at', r.created_at)
      order by r.created_at, r.card_id) from wm.card_image_reports r where r.user_id = p_uid), '[]'),
    'staff_role', (select s.role from wm.staff s where s.user_id = p_uid));
end $$;

revoke all on schema wm from public, anon, authenticated;
grant usage on schema wm to service_role;
revoke all on all tables in schema wm from public, anon, authenticated;
revoke execute on all functions in schema wm from public, anon, authenticated;
grant execute on all functions in schema wm to service_role;
