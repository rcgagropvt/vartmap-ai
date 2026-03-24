"""
Rewards and referral information.
"""

from src.utils.db import db_pool


async def get_rewards_info(farmer_id: str, language: str) -> dict:
    # Get referral code
    ref_code = await db_pool.fetchrow(
        "SELECT code, total_uses FROM referral_codes WHERE farmer_id = $1",
        farmer_id,
    )

    # Count rewards
    rewards = await db_pool.fetch(
        """SELECT reward_type, SUM(reward_value) AS total
           FROM referral_rewards
           WHERE farmer_id = $1 AND status = 'credited'
           GROUP BY reward_type""",
        farmer_id,
    )

    # Count referrals
    referral_count = await db_pool.fetchval(
        "SELECT COUNT(*) FROM referrals WHERE referrer_id = $1 AND status IN ('qualified','rewarded')",
        farmer_id,
    ) or 0

    if language == "hi":
        text = "🎁 *रिवार्ड और रेफरल:*\n\n"
        if ref_code:
            text += f"🔗 आपका रेफरल कोड: *{ref_code['code']}*\n"
            text += f"👥 सफल रेफरल: {referral_count}\n\n"
        else:
            text += "आपका रेफरल कोड अभी तक नहीं बना है। कुछ और सवाल पूछें!\n\n"

        if rewards:
            text += "*आपके पुरस्कार:*\n"
            for r in rewards:
                text += f"  ⭐ {r['reward_type']}: {r['total']}\n"
        else:
            text += "अभी कोई पुरस्कार नहीं। दोस्तों को बुलाकर पॉइंट्स कमाएं!\n"

        text += "\n💡 अपने दोस्तों को अपना रेफरल कोड भेजें — हर सफल रेफरल पर दोनों को रिवार्ड मिलेगा!"
    else:
        text = "🎁 *Rewards & Referrals:*\n\n"
        if ref_code:
            text += f"🔗 Your referral code: *{ref_code['code']}*\n"
            text += f"👥 Successful referrals: {referral_count}\n\n"
        else:
            text += "Your referral code hasn't been generated yet. Keep using the service!\n\n"

        if rewards:
            text += "*Your rewards:*\n"
            for r in rewards:
                text += f"  ⭐ {r['reward_type']}: {r['total']}\n"
        else:
            text += "No rewards yet. Invite friends to earn points!\n"

        text += "\n💡 Share your referral code with friends — both of you earn rewards for each successful referral!"

    return {"text": text}
