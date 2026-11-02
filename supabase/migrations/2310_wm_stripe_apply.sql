-- ADDITIVE : application des événements Stripe du webhook (D§7.11, D:625, D:629, D:330, G4, G5, G13, G18, G29, G35, G38, G44) —
-- stripe_uid (lecture stable), stripe_apply. Nouvelles fonctions, rien de redéfini. Idempotente.
-- Compatible pg-safeupdate (préchargé par le PostgREST hébergé, même dans les fonctions) : tout DELETE/UPDATE garde un WHERE.
--
-- G29, correspondance par type (o = data.object, t = to_timestamp(event.created)) :
--   | type                                       | joueur (stripe_uid)                     | effet                                                | outcome
--   | checkout.session.completed,                | client_reference_id, metadata.uid,      | lien customer ; payment + wb_2500 + paid : achat     | applied / pending /
--   | checkout.session.async_payment_succeeded   | puis stripe_customers de customer       | (on conflict do nothing) puis, s'il est inséré,      | unresolved
--   |                                            |                                         | +shop.wb_2500 réf. stripe:<session_id> et            |
--   |                                            |                                         | wb_purchased ; non payé : rien (pending) ;           |
--   |                                            |                                         | subscription : achat pro_monthly (wb 0) seulement    |
--   | customer.subscription.created/updated/     | metadata.uid, puis stripe_customers     | upsert subscriptions gardé (G5, G44) ; is_pro        | applied / stale /
--   | deleted                                    |                                         | recalculé (G4) → pro_started / pro_ended ;           | unresolved
--   |                                            |                                         | pierre tombale : stripe_pending recalculé (G35)      |
--   | invoice.paid, invoice.payment_failed       | propriétaire de l'abonnement connu,     | latest_invoice_status/at de l'abonnement s'il existe | applied / unresolved
--   |                                            | parent.subscription_details.metadata    | et si plus récent (à égalité, un échec ne remplace   |
--   |                                            | .uid, puis stripe_customers             | pas paid) ; échec écrit → pro_payment_failed         |
--   | charge.dispute.created, .closed            | aucun                                   | upsert stripe_disputes gardé par t >= event_created  | applied
--   | autre, livemode vrai, objet sans id valide,| —                                       | rien (D:104 : test seulement)                        | ignored
--   | abonnement de statut nul ou inconnu        |                                         |                                                      |
-- G5 : la ligne wm.subscriptions est l'instantané du dernier événement appliqué ; aucun appel API ; fin de période = items.data[0].
-- G44 : t > event_created remplace ; t < event_created jamais (stale) ; à égalité, remplace sauf si le statut stocké est terminal
-- (canceled, incomplete_expired) ou si le statut reçu est incomplete sur un autre statut stocké (created/updated d'un même Checkout dans la
-- même seconde, ordre non garanti).
-- G35 : pour une pierre tombale, stripe_pending = abonnement non terminal, recalculé à chaque événement d'abonnement.
-- G38 : une pierre tombale reçoit encore ses événements (crédit inerte, état d'abonnement) sans aucune notification.
-- Dédoublonnage (D:330) : la ligne stripe_events est insérée dans la transaction de l'effet ; une erreur l'annule avec lui et Stripe
-- réessaie. Ni idem_claim ni wm.actor (Stripe n'est pas un joueur).

-- Joueur d'un objet Stripe : le premier candidat en forme d'uuid qui existe dans profiles, sinon le joueur relié au Customer, sinon nul.
-- Le case garde le cast (jamais d'exception sur 'abc').
create or replace function wm.stripe_uid(p_candidates text[], p_customer text)
returns uuid language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select c::uuid from unnest(p_candidates) with ordinality u (c, o)
      where case when c ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        then exists (select from public.profiles where id = c::uuid) else false end
      order by o limit 1),
    (select user_id from wm.stripe_customers where customer_id = p_customer))
$$;

-- Un événement signé du webhook (G14) en une transaction. Rend {duplicate, outcome} ; 503 en maintenance (Stripe réessaie), 400 si id,
-- type ou created manquent. Premier verrou : l'index unique de stripe_events (une livraison simultanée du même événement attend puis
-- devient un doublon) ; puis le seul profil du joueur (C4).
create or replace function wm.stripe_apply(p_event jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  o jsonb := p_event -> 'data' -> 'object';
  v_id text := p_event ->> 'id';
  v_type text := p_event ->> 'type';
  v_live boolean := coalesce(p_event -> 'livemode' = 'true'::jsonb, false);
  t timestamptz;
  v_uid uuid;
  v_tomb boolean;
  v_pro boolean;
  v_wb int;
  v_outcome text := 'applied';
begin
  if (select value from wm.config where key = 'maintenance') = 'true'::jsonb then
    perform wm.raise_err(503, 'maintenance', 'Maintenance en cours, reviens dans quelques minutes.');
  end if;
  if v_id is null or v_id not like 'evt\_%' or v_type is null or coalesce(p_event ->> 'created', '') !~ '^[0-9]{1,12}$' then
    perform wm.raise_err(400, 'invalid_request', 'Événement invalide');
  end if;
  t := to_timestamp((p_event ->> 'created')::bigint);
  perform set_config('lock_timeout', '2s', true);
  insert into wm.stripe_events (id, type, created, livemode) values (v_id, v_type, t, v_live) on conflict (id) do nothing;
  if not found then
    return jsonb_build_object('duplicate', true, 'outcome', null);
  end if;

  if v_live then
    v_outcome := 'ignored';

  elsif v_type in ('checkout.session.completed', 'checkout.session.async_payment_succeeded') and o ->> 'id' like 'cs\_%' then
    v_uid := wm.stripe_uid(array[o ->> 'client_reference_id', o -> 'metadata' ->> 'uid'], o ->> 'customer');
    if v_uid is null then
      v_outcome := 'unresolved';
    else
      perform wm.lock_user(v_uid);
      v_tomb := exists (select from wm.deleted_accounts where user_id = v_uid);
      if o ->> 'customer' like 'cus\_%' then
        insert into wm.stripe_customers (customer_id, user_id) values (o ->> 'customer', v_uid) on conflict do nothing;
      end if;
      if o ->> 'mode' = 'payment' and o -> 'metadata' ->> 'item' = 'wb_2500' then
        if o ->> 'payment_status' = 'paid' then
          v_wb := (select (value ->> 'wb_2500')::int from wm.config where key = 'shop');
          -- Une session = un achat = un crédit, quel que soit l'événement (completed ou async_payment_succeeded, D:625).
          insert into wm.purchases (session_id, user_id, item, amount, currency, consent, wb)
          values (o ->> 'id', v_uid, 'wb_2500', coalesce((o ->> 'amount_total')::int, 0), coalesce(o ->> 'currency', ''),
            o -> 'consent' ->> 'terms_of_service', v_wb)
          on conflict do nothing;
          if found then
            perform wm.wallet_apply(v_uid, v_wb, 'stripe', 'stripe:' || (o ->> 'id'));
            if not v_tomb then
              insert into public.notifications (user_id, type, data)
              values (v_uid, 'wb_purchased', jsonb_build_object('amount', v_wb, 'session_id', o ->> 'id'));
            end if;
          end if;
        else
          v_outcome := 'pending';
        end if;
      elsif o ->> 'mode' = 'subscription' then
        insert into wm.purchases (session_id, user_id, item, amount, currency, consent, wb)
        values (o ->> 'id', v_uid, 'pro_monthly', coalesce((o ->> 'amount_total')::int, 0), coalesce(o ->> 'currency', ''),
          o -> 'consent' ->> 'terms_of_service', 0)
        on conflict do nothing;
      end if;
    end if;

  elsif v_type in ('customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted')
      and o ->> 'id' like 'sub\_%'
      and o ->> 'status' in ('active', 'canceled', 'incomplete', 'incomplete_expired', 'past_due', 'paused', 'trialing', 'unpaid') then
    -- Le propriétaire d'une ligne connue ne change pas (user_id jamais réécrit) : un metadata.uid retouché ne déplace pas l'abonnement.
    v_uid := coalesce((select user_id from wm.subscriptions where id = o ->> 'id'),
      wm.stripe_uid(array[o -> 'metadata' ->> 'uid'], o ->> 'customer'));
    if v_uid is null then
      v_outcome := 'unresolved';
    else
      perform wm.lock_user(v_uid);
      v_tomb := exists (select from wm.deleted_accounts where user_id = v_uid);
      if o ->> 'customer' like 'cus\_%' then
        insert into wm.stripe_customers (customer_id, user_id) values (o ->> 'customer', v_uid) on conflict do nothing;
      end if;
      insert into wm.subscriptions as s (id, user_id, customer_id, status, price_id, current_period_end, cancel_at_period_end, cancel_at,
        canceled_at, event_created)
      values (o ->> 'id', v_uid, coalesce(o ->> 'customer', ''), o ->> 'status', o -> 'items' -> 'data' -> 0 -> 'price' ->> 'id',
        to_timestamp((o -> 'items' -> 'data' -> 0 ->> 'current_period_end')::bigint),
        coalesce((o ->> 'cancel_at_period_end')::boolean, false), to_timestamp((o ->> 'cancel_at')::bigint),
        to_timestamp((o ->> 'canceled_at')::bigint), t)
      on conflict (id) do update set customer_id = excluded.customer_id, status = excluded.status, price_id = excluded.price_id,
        current_period_end = excluded.current_period_end, cancel_at_period_end = excluded.cancel_at_period_end,
        cancel_at = excluded.cancel_at, canceled_at = excluded.canceled_at, event_created = excluded.event_created, updated_at = now()
      where excluded.event_created > s.event_created
        or (excluded.event_created = s.event_created and s.status not in ('canceled', 'incomplete_expired')
          and not (excluded.status = 'incomplete' and s.status <> 'incomplete'));
      if not found then
        v_outcome := 'stale';
      end if;
      v_pro := exists (select from wm.subscriptions where user_id = v_uid and status in ('active', 'trialing'));
      update public.profiles set is_pro = v_pro where id = v_uid and is_pro is distinct from v_pro;
      if found and not v_tomb then
        insert into public.notifications (user_id, type, data)
        values (v_uid, case when v_pro then 'pro_started' else 'pro_ended' end, jsonb_build_object('subscription_id', o ->> 'id'));
      end if;
      if v_tomb then
        update wm.deleted_accounts set stripe_pending = exists (select from wm.subscriptions where user_id = v_uid
          and status in ('active', 'trialing', 'past_due', 'incomplete', 'unpaid', 'paused'))
        where user_id = v_uid;
      end if;
    end if;

  elsif v_type in ('invoice.paid', 'invoice.payment_failed') then
    -- Comme pour les abonnements : le propriétaire de la ligne connue d'abord.
    v_uid := coalesce((select user_id from wm.subscriptions where id = o -> 'parent' -> 'subscription_details' ->> 'subscription'),
      wm.stripe_uid(array[o -> 'parent' -> 'subscription_details' -> 'metadata' ->> 'uid'], o ->> 'customer'));
    if v_uid is null then
      v_outcome := 'unresolved';
    else
      perform wm.lock_user(v_uid);
      v_tomb := exists (select from wm.deleted_accounts where user_id = v_uid);
      -- À égalité de date (même facture : invoice.created ne bouge pas entre un échec et sa relance payée), un échec ne remplace
      -- jamais paid ; sinon le dernier reçu l'emporte.
      update wm.subscriptions set latest_invoice_status = case v_type when 'invoice.paid' then 'paid' else 'payment_failed' end,
        latest_invoice_at = to_timestamp((o ->> 'created')::bigint), updated_at = now()
      where id = o -> 'parent' -> 'subscription_details' ->> 'subscription' and user_id = v_uid
        and (latest_invoice_at is null or latest_invoice_at < to_timestamp((o ->> 'created')::bigint)
          or (latest_invoice_at = to_timestamp((o ->> 'created')::bigint)
            and not (latest_invoice_status = 'paid' and v_type = 'invoice.payment_failed')));
      if found and v_type = 'invoice.payment_failed' and not v_tomb then
        insert into public.notifications (user_id, type, data) values (v_uid, 'pro_payment_failed',
          jsonb_build_object('subscription_id', o -> 'parent' -> 'subscription_details' ->> 'subscription', 'invoice_id', o ->> 'id'));
      end if;
    end if;

  elsif v_type in ('charge.dispute.created', 'charge.dispute.closed') and o ->> 'id' like 'dp\_%' then
    insert into wm.stripe_disputes as d (id, charge_id, amount, currency, reason, status, created_at, event_created)
    values (o ->> 'id', o ->> 'charge', coalesce((o ->> 'amount')::int, 0), coalesce(o ->> 'currency', ''), o ->> 'reason',
      coalesce(o ->> 'status', ''), coalesce(to_timestamp((o ->> 'created')::bigint), t), t)
    on conflict (id) do update set charge_id = excluded.charge_id, amount = excluded.amount, currency = excluded.currency,
      reason = excluded.reason, status = excluded.status, created_at = excluded.created_at, event_created = excluded.event_created,
      updated_at = now()
    where excluded.event_created >= d.event_created;

  else
    v_outcome := 'ignored';
  end if;

  update wm.stripe_events set outcome = v_outcome where id = v_id;
  return jsonb_build_object('duplicate', false, 'outcome', v_outcome);
end $$;

revoke all on schema wm from public, anon, authenticated;
grant usage on schema wm to service_role;
revoke all on all tables in schema wm from public, anon, authenticated;
revoke execute on all functions in schema wm from public, anon, authenticated;
grant execute on all functions in schema wm to service_role;
