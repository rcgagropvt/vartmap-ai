# intelligence-service/src/rewards/spin_wheel.py

import random
from typing import Optional


class SpinWheelEngine:
    """
    Implements the spin-the-wheel instant gratification game.
    Prizes are configured per campaign with probability weights.
    """

    def __init__(self, db, redis, payout_service, messenger):
        self.db = db
        self.redis = redis
        self.payout = payout_service
        self.messenger = messenger

    async def spin(self, farmer_id: str, campaign_id: str,
                   coupon_code: str) -> dict:
        """
        Execute a spin for a farmer.
        Returns the prize result.
        """
        # 1. Validate coupon code
        coupon = await self.db.fetchrow("""
            SELECT * FROM reward_coupon_codes
            WHERE code = $1 AND campaign_id = $2
        """, coupon_code, campaign_id)

        if not coupon:
            return {'success': False, 'error': 'invalid_code'}
        if coupon['status'] != 'active':
            return {'success': False, 'error': 'already_used',
                    'redeemed_at': coupon.get('redeemed_at')}

        # 2. Get prizes for this campaign
        prizes = await self.db.fetch("""
            SELECT * FROM reward_prizes
            WHERE campaign_id = $1
              AND (quantity_remaining > 0 OR quantity_remaining IS NULL)
            ORDER BY probability_pct DESC
        """, campaign_id)

        if not prizes:
            return {'success': False, 'error': 'no_prizes_available'}

        # 3. Weighted random selection
        total_probability = sum(p['probability_pct'] for p in prizes)
        rand_val = random.uniform(0, total_probability)
        cumulative = 0
        selected_prize = prizes[-1]  # default to last (usually "try again")

        for prize in prizes:
            cumulative += prize['probability_pct']
            if rand_val <= cumulative:
                selected_prize = prize
                break

        # 4. Mark coupon as redeemed
        await self.db.execute("""
            UPDATE reward_coupon_codes SET
                status = 'redeemed',
                redeemed_by = $1,
                redeemed_at = NOW(),
                prize_won = $2
            WHERE code = $3
        """, farmer_id, selected_prize['id'], coupon_code)

        # 5. Decrement prize quantity
        if selected_prize.get('quantity_total'):
            await self.db.execute("""
                UPDATE reward_prizes SET
                    quantity_remaining = quantity_remaining - 1
                WHERE id = $1 AND quantity_remaining > 0
            """, selected_prize['id'])

        # 6. Award points if applicable
        if selected_prize.get('value_amount'):
            await self._award_points(farmer_id, campaign_id,
                                     int(selected_prize['value_amount']))

        # 7. Create redemption record
        await self.db.execute("""
            INSERT INTO reward_redemptions
                (id, participant_id, participant_type, campaign_id,
                 prize_id, redemption_type, amount, payment_status)
            VALUES (gen_random_uuid(), $1, 'farmer', $2, $3, $4, $5, $6)
        """, farmer_id, campaign_id, selected_prize['id'],
            selected_prize['type'], selected_prize.get('value_amount'),
            'pending' if selected_prize['type'] == 'cashback' else 'completed')

        # 8. Update campaign stats
        await self.db.execute("""
            UPDATE reward_campaigns SET
                total_entries = total_entries + 1,
                total_rewards_given = total_rewards_given + 1,
                budget_spent = budget_spent + COALESCE($2, 0)
            WHERE id = $1
        """, campaign_id, selected_prize.get('value_amount'))

        # 9. Initiate cashback if applicable
        if selected_prize['type'] == 'cashback' and selected_prize.get('value_amount'):
            asyncio.create_task(
                self.payout.process_cashback(farmer_id, selected_prize)
            )

        return {
            'success': True,
            'prize': {
                'name': selected_prize['name'],
                'type': selected_prize['type'],
                'value': selected_prize.get('value_amount'),
            }
        }

    async def _award_points(self, farmer_id, campaign_id, points):
        """Add points to farmer's loyalty ledger."""
        # Get current balance
        current = await self.db.fetchval("""
            SELECT COALESCE(SUM(points), 0)
            FROM reward_points_ledger
            WHERE participant_id = $1 AND participant_type = 'farmer'
        """, farmer_id)

        new_balance = current + points

        await self.db.execute("""
            INSERT INTO reward_points_ledger
                (id, participant_id, participant_type, campaign_id,
                 transaction_type, points, balance_after, source)
            VALUES (gen_random_uuid(), $1, 'farmer', $2,
                    'earned', $3, $4, 'spin_win')
        """, farmer_id, campaign_id, points, new_balance)
