import { z } from 'zod'

// Entrées des routes, partagées avec l'UI. Les query strings arrivent en chaînes (une clé répétée en tableau, lib/route.ts).
export const Rarity = z.enum(['C', 'PC', 'R', 'SR', 'UR', 'L'])
export const rarityList = z.union([z.array(Rarity), Rarity.transform((r) => [r])])
// Borné à l'int de PG : au-delà, un 22003 deviendrait un 500.
export const intParam = z.coerce.number().int().min(0).max(2_147_483_647)
export const pageParam = intParam.default(0)
export const CollectionSort = z.enum(['rarity', 'obtained_at', 'added', 'name', 'atk', 'def', 'starred'])
export const boolParam = z.enum(['1', 'true', '0', 'false']).optional().transform((v) => v === '1' || v === 'true')
// Postgres refuse \0 dans un texte (22P05), PostgREST une demi-paire UTF-16 seule (PGRST102) : sans ce refus, un 500 au lieu d'un 400.
// Tout texte libre qui atteint le SQL passe par lui. \p{Cs} sous `u` ne voit que les demi-paires seules (isWellFormed manque aux Firefox d'avant 119).
const pgOk = (s: string) => !s.includes('\0') && !/\p{Cs}/u.test(s)
export const pgText = z.string().refine(pgOk, 'Caractère invalide')
export const Username = pgText.min(1).max(64)
export const AuctionParams = z.object({ auctionId: z.uuid() })
export const FriendshipParams = z.object({ friendshipId: z.uuid() })
export const TradeParams = z.object({ tradeId: z.uuid() })
export const PeerParams = z.object({ peerId: z.uuid() })
export const BattleParams = z.object({ battleId: z.uuid() })
export const BattleCreate = z.object({ opponent_id: z.uuid() })
// Corps de PATCH /api/battles/{battleId}, passé entier en p_payload ; questionId et answerId en camelCase (R:277), règles métier en SQL (P11).
export const BattleAction = z.object({
  action: pgText,
  card_ids: z.array(z.uuid()).max(10).optional(),
  attack_card_id: z.uuid().optional(),
  questionId: z.uuid().optional(),
  answerId: z.uuid().optional(),
  // forfeit : la phase confirmée par la modale (annulation ou défaite), 409 en SQL si elle a changé.
  expect: z.enum(['cancel', 'lose']).optional(),
})
// Corps de POST /api/trades, partagé avec le composer. items : une unité par élément, deux côtés × 100 ; les plafonds par côté et leurs
// messages français sont des règles SQL (P11).
export const TradeBody = z.object({
  recipient_id: z.uuid(),
  items: z.array(z.object({ user_card_id: z.uuid(), card_id: z.uuid(), offered_by: z.uuid() })).max(200),
  initiator_wikibidous: z.int32().default(0),
  recipient_wikibidous: z.int32().default(0),
  parent_trade_id: z.uuid().nullish(),
})
// GET /api/marketplace : page à partir de 1, gardée ici pour la clé du cache et en SQL (P24) ; tri validé en SQL (« Tri inconnu »).
export const MarketQuery = z.object({ page: z.coerce.number().int().min(1, 'La page commence à 1').max(2_147_483_647).default(1),
  limit: z.coerce.number().int().optional(), sort: pgText.optional(), q: pgText.optional(), rarity: rarityList.optional(), mine: boolParam,
  card_id: z.uuid().optional() })

// Filtres de /api/my-collection et de /stats ; une clé inconnue (pending, stats, sort pour /stats) est ignorée.
export const CollectionFilters = z.object({
  q: pgText.optional(),
  search: pgText.optional(),
  rarity: rarityList.optional(),
  tag_id: z.uuid().optional(),
  untagged: boolParam,
  wishlisted_by: z.uuid().optional(),
  owned_by: z.uuid().optional(),
})
export const CollectionQuery = CollectionFilters.extend({ page: pageParam, limit: intParam.optional(), sort: CollectionSort.optional() })

export const filterArgs = (i: z.infer<typeof CollectionFilters>) => ({
  // || et non ?? : un q= vide ne masque pas search.
  p_q: i.q || i.search,
  p_rarity: i.rarity, p_tag_id: i.tag_id, p_untagged: i.untagged, p_wishlisted_by: i.wishlisted_by, p_owned_by: i.owned_by,
})

// Corps de PATCH /api/profile/{username} : avatar_user_card_id à null retire l'avatar, absent le garde (p_avatar_set).
export const ProfilePatch = z.object({ bio: pgText.optional(), is_public: z.boolean().optional(), avatar_user_card_id: z.uuid().nullable().optional() })
// Vitrine : l'emplacement 0 à 3 est une règle SQL (« Emplacement de vitrine inconnu (0 à 3) ») ; int32 pour éviter un 22003.
export const ShowcaseBody = z.object({ position: z.int32(), user_card_id: z.uuid() })
export const ShowcasePosition = z.object({ position: z.int32() })
// Motif et longueur des détails validés en SQL.
export const ReportBody = z.object({ reportedUserId: z.uuid(), reason: pgText, details: pgText.optional() })
// Message privé : vide, blancs seuls et plus de 2 000 caractères (points de code) refusés en SQL ; le contenu part tel quel, sans rognage.
export const ChatBody = z.object({ content: pgText })
// Guildes (R§3.10) : longueurs et bornes en SQL (P11).
export const GuildParams = z.object({ guildId: z.uuid() })
export const GuildCreate = z.object({ name: pgText, description: pgText.nullish() })
export const GuildJoin = z.object({ guild_id: z.uuid() })
export const GuildTarget = z.object({ user_id: z.uuid() })
export const GuildWish = z.object({ card_id: z.uuid() })
export const GuildDonate = z.object({ wishlist_id: z.uuid(), user_card_id: z.uuid() })
export const GuildMembersQuery = z.object({ limit: intParam.optional(), offset: intParam.default(0) })

// Abonnement push (M4b-12) : la forme seulement, chaque refus en « Abonnement push invalide » ; l'origine est contrôlée en SQL (B9), le
// point sur la courbe dans la route (node:crypto). Tailles sans Buffer, ce fichier partant au navigateur : 65 octets en base64url sans
// remplissage font 87 caractères, le premier B (0x04) et le dernier porteur de 4 bits ; 16 octets font 22 caractères, le dernier porteur de 2.
// z.url() laisse passer \0 et une demi-paire dans le chemin : le refus de pgText, sinon un 500 de PostgREST.
const INVALID_PUSH = 'Abonnement push invalide'
const pushUrl = z.url({ error: INVALID_PUSH }).max(2048, INVALID_PUSH).refine(pgOk, INVALID_PUSH)
export const PushEndpoint = z.object({ endpoint: pushUrl }, { error: INVALID_PUSH })
export const PushSubscriptionBody = PushEndpoint.extend({
  keys: z.object({
    p256dh: z.string({ error: INVALID_PUSH }).regex(/^B[A-Za-z0-9_-]{85}[AEIMQUYcgkosw048]$/, INVALID_PUSH),
    auth: z.string({ error: INVALID_PUSH }).regex(/^[A-Za-z0-9_-]{21}[AQgw]$/, INVALID_PUSH),
  }, { error: INVALID_PUSH }),
})
// Types validés en SQL (« Type de notification inconnu ») ; 13 aujourd'hui.
export const PushTypes = z.object({ push_types: z.array(pgText).max(20) })
