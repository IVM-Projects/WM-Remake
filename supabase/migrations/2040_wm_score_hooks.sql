-- ADDITIVE : crochets du score de guilde hebdomadaire (D§7.8, M5b-2, M5b-3, G5, D:472, D:535, D:576) — +500 au gagnant de toute bataille
-- finie, prix final au vendeur d'une vente réglée, par wm.guild_score_add (2000), sans effet pour un joueur sans guilde. Idempotente.
-- Compatible pg-safeupdate (préchargé par le PostgREST hébergé, même dans les fonctions) : tout DELETE/UPDATE garde un WHERE.

-- Redéfinie de 1930 : même signature, même corps et même réponse qu'en 1930 (déployée, non retouchée), plus le score de guilde (M5b-2,
-- M5b-3, D:472, D:535, D:576).
-- Fin de partie (M5a-2), appelée bataille et deux profils tenus : completed seulement depuis active (sinon XX000, jamais atteint par un
-- appelant correct), reward_win et reward_loss par wallet_apply par id croissant (M4-4), battles_won par upsert (user_stats absente d'un
-- profil migré, C19), battle_won et battle_lost (C10), puis guild_points_win à la guilde du gagnant, même contre un membre de sa guilde
-- (M5b-3), écrit dans game_state.guildPoints (G5, 0 sans guilde) sur la ligne déjà tenue.
create or replace function wm.battle_finish(p_battle_id uuid, p_winner uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  c jsonb := (select value from wm.config where key = 'battle');
  b public.battles;
  v_loser uuid;
  v_u uuid;
  v_gp int;
begin
  update public.battles set status = 'completed', winner_id = p_winner, updated_at = clock_timestamp(),
    game_state = game_state || jsonb_build_object('phase', 'over', 'winnerId', p_winner, 'pendingAttack', null)
  where id = p_battle_id and status = 'active'
  returning * into b;
  if not found then
    raise exception 'battle_finish : bataille % non active', p_battle_id using errcode = 'XX000';
  end if;
  v_loser := case when p_winner = b.challenger_id then b.opponent_id else b.challenger_id end;
  for v_u in select u from unnest(array[b.challenger_id, b.opponent_id]) u order by u loop
    perform wm.wallet_apply(v_u, (c ->> case when v_u = p_winner then 'reward_win' else 'reward_loss' end)::int, 'battle', 'battle:' || b.id);
  end loop;
  insert into wm.user_stats as s (user_id, battles_won) values (p_winner, 1)
  on conflict (user_id) do update set battles_won = s.battles_won + 1;
  -- Deux insertions hors de l'ordre des id (P28) sans risque : l'appelant tient déjà les deux profils en exclusif (lock_users).
  perform wm.notify_battle(array[p_winner], 'battle_won', b.id, v_loser);
  perform wm.notify_battle(array[v_loser], 'battle_lost', b.id, p_winner);
  -- Score de guilde en dernier (M5b-2) : la guilde prise en partage après les profils (C4) ; now(), début de la transaction (C18).
  v_gp := wm.guild_score_add(p_winner, 'battles', (c ->> 'guild_points_win')::int, now());
  update public.battles set game_state = game_state || jsonb_build_object('guildPoints', v_gp) where id = b.id;
end $$;

-- Redéfinie de 1630 : même signature, même corps et même réponse qu'en 1630 (déployée, non retouchée), plus le score de guilde du vendeur
-- (M5b-2, D:576).
-- {id, status, settled} ; settled vrai seulement si cet appel a réglé ; null si inconnue. Sans actor : le cron règle même en maintenance.
create or replace function wm.settle_auction(p_auction_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  a public.auctions;
  v_at timestamptz;
begin
  perform set_config('lock_timeout', '2s', true);
  select * into a from public.auctions where id = p_auction_id for update;
  if not found then
    return null;
  end if;
  -- Heure réelle sous le verrou (M3-11) : une mise qui l'a tenu a pu repousser end_at.
  if a.status <> 'active' or a.end_at > clock_timestamp() then
    return jsonb_build_object('id', a.id, 'status', a.status, 'settled', false);
  end if;
  -- Déjà tenus dans un lot (P9) : rien de plus n'est pris. Les deux notifications ne touchent ensuite que des profils verrouillés.
  perform wm.lock_users(array[a.seller_id, a.current_bidder_id]);
  v_at := clock_timestamp();  -- P7
  -- Score de guilde du vendeur au règlement (M5b-2) ; les statistiques du marché sont calculées au check des succès (D-C16).
  if a.current_bidder_id is null then
    perform wm.notify_auction(array[a.seller_id], 'auction_unsold', a.id);  -- avant escrow_release, qui efface le séquestre lu ici
    perform wm.escrow_release(a.id, a.seller_id);
    update public.auctions set status = 'settled_unsold', settled_at = v_at where id = a.id returning * into a;
  else
    perform wm.notify_auction(array[a.current_bidder_id], 'auction_won', a.id, a.current_bid);
    perform wm.notify_auction(array[a.seller_id], 'auction_sold', a.id, a.current_bid);
    perform wm.escrow_release(a.id, a.current_bidder_id, v_at);
    perform wm.wallet_apply(a.seller_id, a.current_bid, 'settle', 'settle:' || a.id);
    update public.auctions set status = 'settled_sold', winner_id = current_bidder_id, final_price = current_bid, settled_at = v_at
    where id = a.id returning * into a;
    perform wm.guild_score_add(a.seller_id, 'wb', a.final_price, now());
  end if;
  return jsonb_build_object('id', a.id, 'status', a.status, 'settled', true);
end $$;

revoke all on schema wm from public, anon, authenticated;
grant usage on schema wm to service_role;
revoke all on all tables in schema wm from public, anon, authenticated;
revoke execute on all functions in schema wm from public, anon, authenticated;
grant execute on all functions in schema wm to service_role;
