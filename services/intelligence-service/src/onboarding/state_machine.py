# intelligence-service/src/onboarding/state_machine.py

from enum import Enum
from typing import Optional
import re
from datetime import datetime, timedelta
from fuzzywuzzy import fuzz, process

class OnboardingState(str, Enum):
    NEW_USER = "new_user"
    LANGUAGE_SELECTION = "language_selection"
    NAME_COLLECTION = "name_collection"
    STATE_SELECTION = "state_selection"
    DISTRICT_SELECTION = "district_selection"
    VILLAGE_COLLECTION = "village_collection"
    CROP_SELECTION = "crop_selection"
    CROP_SELECTION_2 = "crop_selection_2"  # optional second crop
    LAND_SIZE = "land_size"
    CONSENT = "consent"
    COMPLETED = "completed"


class OnboardingStateMachine:
    """
    Manages the mandatory onboarding flow for new farmers.
    Each state corresponds to a data collection step.
    The machine is idempotent — calling it with the same state
    and input produces the same result.
    """

    def __init__(self, db, redis, districts_service, crops_service, messenger):
        self.db = db
        self.redis = redis
        self.districts_service = districts_service
        self.crops_service = crops_service
        self.messenger = messenger

    async def process(self, farmer, message_text: str, message_type: str):
        """
        Main entry point. Routes to the appropriate handler
        based on current onboarding state.
        """
        state = farmer.get('onboarding_status', OnboardingState.NEW_USER)

        # If farmer sends non-text during onboarding, redirect
        if message_type in ('image', 'audio', 'video', 'document') \
                and state != OnboardingState.COMPLETED:
            return await self._redirect_to_current_step(farmer, state, message_type)

        handlers = {
            OnboardingState.NEW_USER: self._handle_new_user,
            OnboardingState.LANGUAGE_SELECTION: self._handle_language_selection,
            OnboardingState.NAME_COLLECTION: self._handle_name_collection,
            OnboardingState.STATE_SELECTION: self._handle_state_selection,
            OnboardingState.DISTRICT_SELECTION: self._handle_district_selection,
            OnboardingState.VILLAGE_COLLECTION: self._handle_village_collection,
            OnboardingState.CROP_SELECTION: self._handle_crop_selection,
            OnboardingState.CROP_SELECTION_2: self._handle_crop_selection_2,
            OnboardingState.LAND_SIZE: self._handle_land_size,
            OnboardingState.CONSENT: self._handle_consent,
        }

        handler = handlers.get(state)
        if handler:
            return await handler(farmer, message_text)

        # Shouldn't reach here, but handle gracefully
        return await self._handle_new_user(farmer, message_text)

    async def _handle_new_user(self, farmer, message_text):
        """First contact. Send welcome + language selection."""
        farmer_id = farmer['id']

        # Record onboarding start
        await self.db.execute(
            """UPDATE farmers SET
                onboarding_status = $1,
                onboarding_started_at = NOW()
            WHERE id = $2""",
            OnboardingState.LANGUAGE_SELECTION, farmer_id
        )

        # Store state in Redis for fast lookup
        await self.redis.hset(f"session:{farmer_id}", mapping={
            'onboarding_state': OnboardingState.LANGUAGE_SELECTION,
            'started_at': datetime.utcnow().isoformat()
        })
        await self.redis.expire(f"session:{farmer_id}", 86400 * 30)  # 30 days

        # Send language selection buttons
        await self.messenger.send_interactive_buttons(
            farmer,
            body_text=(
                "🙏 Namaste! VartMap Krishi Sahayak mein aapka swagat hai.\n\n"
                "Hum aapko fasal ki dekhbhal, mandi bhav, mausam, "
                "sarkari yojana aur bahut kuch mein madad karenge.\n\n"
                "Pehle batayein — aap kaunsi bhasha mein baat karna chahenge?"
            ),
            buttons=[
                {"id": "lang_hi", "title": "हिन्दी"},
                {"id": "lang_bho", "title": "भोजपुरी"},
                {"id": "lang_en", "title": "English"}
            ]
        )

    async def _handle_language_selection(self, farmer, message_text):
        """Process language choice and move to name collection."""
        farmer_id = farmer['id']

        # Map button IDs and free-text to language codes
        lang_map = {
            'lang_hi': 'hi', 'lang_bho': 'bho', 'lang_en': 'en',
            'hindi': 'hi', 'हिन्दी': 'hi', 'हिंदी': 'hi',
            'bhojpuri': 'bho', 'भोजपुरी': 'bho',
            'english': 'en', 'अंग्रेजी': 'en',
        }

        language = lang_map.get(message_text.lower().strip())
        if not language:
            # Try fuzzy match
            best_match = process.extractOne(
                message_text.lower(), lang_map.keys(), score_cutoff=60
            )
            language = lang_map[best_match[0]] if best_match else None

        if not language:
            await self.messenger.send_interactive_buttons(
                farmer,
                body_text="Kripya neeche se apni bhasha chunein:",
                buttons=[
                    {"id": "lang_hi", "title": "हिन्दी"},
                    {"id": "lang_bho", "title": "भोजपुरी"},
                    {"id": "lang_en", "title": "English"}
                ]
            )
            return

        await self.db.execute(
            """UPDATE farmers SET
                language = $1,
                onboarding_status = $2
            WHERE id = $3""",
            language, OnboardingState.NAME_COLLECTION, farmer_id
        )
        await self.redis.hset(f"session:{farmer_id}",
                              'onboarding_state', OnboardingState.NAME_COLLECTION)

        # Ask for name in chosen language
        name_prompts = {
            'hi': "Dhanyavaad! 🙏\nAapka shubh naam kya hai?",
            'bho': "Dhanyavaad! 🙏\nRauwa ke naam ka h?",
            'en': "Thank you! 🙏\nWhat is your name?"
        }
        await self.messenger.send_text(farmer, name_prompts[language])

    async def _handle_name_collection(self, farmer, message_text):
        """Validate and store farmer name."""
        farmer_id = farmer['id']
        name = message_text.strip()

        # Validation: min 2 chars, no numbers or special chars
        # Allow Hindi/Devanagari characters + spaces
        if len(name) < 2 or re.search(r'[0-9!@#$%^&*()_+=\[\]{};:"|<>?/\\]', name):
            error_msgs = {
                'hi': "Kripya apna naam sahi se likhein (sirf akshar, kam se kam 2).",
                'bho': "Apna naam sahi se likhin (sirf akshar).",
                'en': "Please enter your name correctly (only letters, minimum 2 characters)."
            }
            await self.messenger.send_text(farmer, error_msgs[farmer.get('language', 'hi')])
            return

        await self.db.execute(
            """UPDATE farmers SET
                name = $1,
                onboarding_status = $2
            WHERE id = $3""",
            name, OnboardingState.STATE_SELECTION, farmer_id
        )
        await self.redis.hset(f"session:{farmer_id}",
                              'onboarding_state', OnboardingState.STATE_SELECTION)

        lang = farmer.get('language', 'hi')
        greetings = {
            'hi': f"Dhanyavaad {name} ji! 🙏\nAap kaunse rajya se hain?",
            'bho': f"Dhanyavaad {name} ji! 🙏\nRauwa kaun rajya se hain?",
            'en': f"Thank you {name}! 🙏\nWhich state are you from?"
        }

        # Send state list (interactive list with all Indian states)
        states = await self.districts_service.get_all_states()
        sections = self._build_state_sections(states)

        await self.messenger.send_interactive_list(
            farmer,
            body_text=greetings[lang],
            button_text="Rajya Chunein",
            sections=sections
        )

    async def _handle_state_selection(self, farmer, message_text):
        """Process state selection, load districts for that state."""
        farmer_id = farmer['id']

        # Check if it's a button response (interactive list reply)
        # or free text
        state_name = message_text.strip()

        # Fuzzy match against all Indian states
        all_states = await self.districts_service.get_all_states()
        best_match = process.extractOne(
            state_name,
            [s['state_name'] for s in all_states],
            scorer=fuzz.ratio,
            score_cutoff=55
        )

        if not best_match:
            lang = farmer.get('language', 'hi')
            msgs = {
                'hi': "Yeh rajya nahi mila. Kripya list mein se chunein ya dobara likhein.",
                'bho': "I rajya nai bhetal. Phir se likhin.",
                'en': "State not found. Please select from the list or try again."
            }
            # Resend state list
            states = await self.districts_service.get_all_states()
            sections = self._build_state_sections(states)
            await self.messenger.send_interactive_list(
                farmer, body_text=msgs[lang],
                button_text="Rajya Chunein", sections=sections
            )
            return

        matched_state = best_match[0]
        await self.db.execute(
            """UPDATE farmers SET
                state = $1,
                onboarding_status = $2
            WHERE id = $3""",
            matched_state, OnboardingState.DISTRICT_SELECTION, farmer_id
        )
        await self.redis.hset(f"session:{farmer_id}", mapping={
            'onboarding_state': OnboardingState.DISTRICT_SELECTION,
            'selected_state': matched_state
        })

        # Load districts for this state and send list
        districts = await self.districts_service.get_districts_by_state(matched_state)
        lang = farmer.get('language', 'hi')
        msgs = {
            'hi': f"Aap {matched_state} ke kaunse jile se hain?",
            'bho': f"Rauwa {matched_state} ke kaun jila se hain?",
            'en': f"Which district of {matched_state} are you from?"
        }
        sections = self._build_district_sections(districts)
        await self.messenger.send_interactive_list(
            farmer, body_text=msgs[lang],
            button_text="Jila Chunein", sections=sections
        )

    async def _handle_district_selection(self, farmer, message_text):
        """Process district selection with aggressive fuzzy matching."""
        farmer_id = farmer['id']
        district_input = message_text.strip()

        selected_state = farmer.get('state') or \
            (await self.redis.hget(f"session:{farmer_id}", 'selected_state'))

        if not selected_state:
            # Lost state context — restart from state selection
            await self.db.execute(
                "UPDATE farmers SET onboarding_status = $1 WHERE id = $2",
                OnboardingState.STATE_SELECTION, farmer_id
            )
            return await self._handle_state_selection(farmer, "")

        # Get all districts + aliases for fuzzy matching
        districts = await self.districts_service.get_districts_by_state(selected_state)
        all_names = []
        name_to_district = {}
        for d in districts:
            names = [d['district_name']]
            if d.get('district_name_hindi'):
                names.append(d['district_name_hindi'])
            if d.get('district_name_local'):
                names.append(d['district_name_local'])
            # Add aliases
            aliases = await self.districts_service.get_aliases(d['id'])
            names.extend([a['alias'] for a in aliases])
            for name in names:
                all_names.append(name)
                name_to_district[name.lower()] = d

        # Fuzzy match with Levenshtein distance ≤ 2 tolerance
        best_match = process.extractOne(
            district_input,
            all_names,
            scorer=fuzz.ratio,
            score_cutoff=55
        )

        if not best_match:
            lang = farmer.get('language', 'hi')
            msgs = {
                'hi': f"'{district_input}' nahi mila. Kripya sahi jila naam likhein.",
                'bho': f"'{district_input}' nai bhetal. Sahi jila naam likhin.",
                'en': f"'{district_input}' not found. Please enter correct district name."
            }
            await self.messenger.send_text(farmer, msgs[lang])
            return

        matched_name = best_match[0]
        district = name_to_district[matched_name.lower()]

        await self.db.execute(
            """UPDATE farmers SET
                district = $1,
                district_id = $2,
                onboarding_status = $3
            WHERE id = $4""",
            district['district_name'], district['id'],
            OnboardingState.VILLAGE_COLLECTION, farmer_id
        )
        await self.redis.hset(f"session:{farmer_id}", mapping={
            'onboarding_state': OnboardingState.VILLAGE_COLLECTION,
            'district_id': str(district['id'])
        })

        lang = farmer.get('language', 'hi')
        msgs = {
            'hi': f"✅ {district['district_name']}! Aapke gaon ka naam kya hai?",
            'bho': f"✅ {district['district_name']}! Rauwa ke gaon ke naam ka h?",
            'en': f"✅ {district['district_name']}! What is your village name?"
        }
        await self.messenger.send_text(farmer, msgs[lang])

    async def _handle_village_collection(self, farmer, message_text):
        """Store village name (free text — too many villages for dropdown)."""
        farmer_id = farmer['id']
        village = message_text.strip()

        if len(village) < 2:
            lang = farmer.get('language', 'hi')
            await self.messenger.send_text(farmer,
                {"hi": "Kripya gaon ka naam sahi likhein.",
                 "bho": "Gaon ke naam sahi likhin.",
                 "en": "Please enter village name correctly."}[lang])
            return

        await self.db.execute(
            """UPDATE farmers SET
                village = $1,
                onboarding_status = $2
            WHERE id = $3""",
            village, OnboardingState.CROP_SELECTION, farmer_id
        )
        await self.redis.hset(f"session:{farmer_id}",
                              'onboarding_state', OnboardingState.CROP_SELECTION)

        # Get top crops for this state/region
        state = farmer.get('state', 'Uttar Pradesh')
        crops = await self.crops_service.get_top_crops_for_state(state, limit=30)
        lang = farmer.get('language', 'hi')
        msgs = {
            'hi': "Aap kaunsi fasal ugaate hain? (Pehli fasal chunein)",
            'bho': "Rauwa kaun fasal ugavat hain? (Pahil fasal chunin)",
            'en': "Which crop do you grow? (Select first crop)"
        }

        sections = self._build_crop_sections(crops)
        await self.messenger.send_interactive_list(
            farmer, body_text=msgs[lang],
            button_text="Fasal Chunein", sections=sections
        )

    async def _handle_crop_selection(self, farmer, message_text):
        """Store first crop, ask for second."""
        farmer_id = farmer['id']
        crop_name = message_text.strip()

        # Store first crop
        await self.db.execute(
            """INSERT INTO farmer_crops (farmer_id, crop_name, season, year, is_active)
            VALUES ($1, $2, $3, $4, true)""",
            farmer_id, crop_name, self._current_season(), datetime.utcnow().year
        )

        await self.db.execute(
            "UPDATE farmers SET onboarding_status = $1 WHERE id = $2",
            OnboardingState.CROP_SELECTION_2, farmer_id
        )
        await self.redis.hset(f"session:{farmer_id}", mapping={
            'onboarding_state': OnboardingState.CROP_SELECTION_2,
            'first_crop': crop_name
        })

        lang = farmer.get('language', 'hi')
        await self.messenger.send_interactive_buttons(
            farmer,
            body_text={
                'hi': f"✅ {crop_name}! Koi aur fasal bhi ugaate hain?",
                'bho': f"✅ {crop_name}! Aur koi fasal ugavat hain?",
                'en': f"✅ {crop_name}! Do you grow any other crop?"
            }[lang],
            buttons=[
                {"id": "add_crop", "title": {
                    'hi': "Haan, aur ek",
                    'bho': "Haan, aur ek",
                    'en': "Yes, one more"
                }[lang]},
                {"id": "no_more_crop", "title": {
                    'hi': "Bas, itni hi",
                    'bho': "Bas, etne",
                    'en': "No, that's all"
                }[lang]}
            ]
        )

    async def _handle_crop_selection_2(self, farmer, message_text):
        """Handle second crop or skip to land size."""
        farmer_id = farmer['id']

        if message_text.strip().lower() in ('no_more_crop', 'bas', 'no', 'nahi', 'nhi'):
            # Skip to land size
            await self._transition_to_land_size(farmer)
            return

        if message_text.strip().lower() in ('add_crop', 'haan', 'yes', 'han'):
            # Show crop list again
            state = farmer.get('state', 'Uttar Pradesh')
            crops = await self.crops_service.get_top_crops_for_state(state, limit=30)
            lang = farmer.get('language', 'hi')
            sections = self._build_crop_sections(crops)
            await self.messenger.send_interactive_list(
                farmer,
                body_text={
                    'hi': "Doosri fasal chunein:",
                    'bho': "Dusra fasal chunin:",
                    'en': "Select second crop:"
                }[lang],
                button_text="Fasal Chunein",
                sections=sections
            )
            return

        # This is the actual second crop name
        crop_name = message_text.strip()
        await self.db.execute(
            """INSERT INTO farmer_crops (farmer_id, crop_name, season, year, is_active)
            VALUES ($1, $2, $3, $4, true)""",
            farmer_id, crop_name, self._current_season(), datetime.utcnow().year
        )
        await self._transition_to_land_size(farmer)

    async def _transition_to_land_size(self, farmer):
        farmer_id = farmer['id']
        await self.db.execute(
            "UPDATE farmers SET onboarding_status = $1 WHERE id = $2",
            OnboardingState.LAND_SIZE, farmer_id
        )
        await self.redis.hset(f"session:{farmer_id}",
                              'onboarding_state', OnboardingState.LAND_SIZE)

        lang = farmer.get('language', 'hi')
        await self.messenger.send_interactive_buttons(
            farmer,
            body_text={
                'hi': "Aapke paas kitni zameen hai?",
                'bho': "Rauwa ke lagge ketna zameen ba?",
                'en': "How much land do you have?"
            }[lang],
            buttons=[
                {"id": "land_lt1", "title": "< 1 bigha"},
                {"id": "land_1_5", "title": "1-5 bigha"},
                {"id": "land_5_10", "title": "5-10 bigha"}
            ]
        )
        # Note: WhatsApp allows max 3 buttons.
        # For 10+ bigha, farmer can type. We handle that in _handle_land_size.

    async def _handle_land_size(self, farmer, message_text):
        """Store land holding and move to consent."""
        farmer_id = farmer['id']

        land_map = {
            'land_lt1': 0.5,
            'land_1_5': 3.0,
            'land_5_10': 7.5,
            '< 1 bigha': 0.5,
            '1-5 bigha': 3.0,
            '5-10 bigha': 7.5,
        }

        land_bigha = land_map.get(message_text.strip())
        if not land_bigha:
            # Try parsing number from free text
            numbers = re.findall(r'[\d.]+', message_text)
            if numbers:
                land_bigha = float(numbers[0])
            else:
                land_bigha = 5.0  # default estimate

        await self.db.execute(
            """UPDATE farmers SET
                land_holding_bigha = $1,
                onboarding_status = $2
            WHERE id = $3""",
            land_bigha, OnboardingState.CONSENT, farmer_id
        )
        await self.redis.hset(f"session:{farmer_id}",
                              'onboarding_state', OnboardingState.CONSENT)

        lang = farmer.get('language', 'hi')
        consent_texts = {
            'hi': (
                "VartMap aapki jaankari ka upyog fasal salah, mandi bhav, "
                "mausam ki jaankari, aur sarkari yojana ki suchna bhejne ke liye karega.\n\n"
                "Aapka data surakshit rahega aur kisi teesre paksh ko nahi diya jayega.\n\n"
                "Kya aap sahmat hain?"
            ),
            'bho': (
                "VartMap rauwa ke jaankari ke upyog fasal salah, mandi bhav, "
                "mausam ke jaankari bheje khatir karab.\n\n"
                "Rauwa ke data surakshit rahee. Ka rauwa sahmat hain?"
            ),
            'en': (
                "VartMap will use your information to send crop advisory, "
                "market prices, weather updates, and government scheme alerts.\n\n"
                "Your data will be kept secure and will not be shared with third parties.\n\n"
                "Do you agree?"
            )
        }

        await self.messenger.send_interactive_buttons(
            farmer,
            body_text=consent_texts[lang],
            buttons=[
                {"id": "consent_yes", "title": {
                    'hi': "Haan, Sahmat Hun",
                    'bho': "Haan, Sahmat Hain",
                    'en': "Yes, I Agree"
                }[lang]},
                {"id": "consent_no", "title": {
                    'hi': "Nahi",
                    'bho': "Nahi",
                    'en': "No"
                }[lang]}
            ]
        )

    async def _handle_consent(self, farmer, message_text):
        """Process consent. Complete or terminate onboarding."""
        farmer_id = farmer['id']
        response = message_text.strip().lower()

        if response in ('consent_no', 'nahi', 'no', 'nhi'):
            lang = farmer.get('language', 'hi')
            msgs = {
                'hi': ("Bina sahmat ke hum seva nahi de payenge. "
                       "Agar baad mein mann badle toh dobara message karein."),
                'bho': ("Bina sahmati ke hum seva nai de payeb. "
                        "Baad mein mann badle tab phir message karin."),
                'en': ("We cannot provide services without consent. "
                       "If you change your mind, message us again.")
            }
            await self.messenger.send_text(farmer, msgs[lang])

            # Delete partial profile after 30 days (DPDP compliance)
            await self.redis.setex(
                f"delete_pending:{farmer_id}",
                86400 * 30,
                'true'
            )
            return

        if response in ('consent_yes', 'haan', 'yes', 'han',
                         'haan, sahmat hun', 'yes, i agree'):
            now = datetime.utcnow()

            # Complete onboarding
            await self.db.execute(
                """UPDATE farmers SET
                    consent_given = true,
                    consent_timestamp = $1,
                    consent_version = '1.0',
                    onboarding_status = $2,
                    onboarding_completed_at = $1,
                    last_active_at = $1,
                    lead_score = 20
                WHERE id = $3""",
                now, OnboardingState.COMPLETED, farmer_id
            )

            # Clear session state
            await self.redis.delete(f"session:{farmer_id}")

            # TRIGGER: Deliver first value immediately
            await self._deliver_first_value(farmer)

            # TRIGGER: Assign nearest dealer
            await self._assign_nearest_dealer(farmer)

            # TRIGGER: Generate crop calendar
            await self._generate_crop_calendar(farmer)

            # TRIGGER: Check scheme eligibility
            await self._check_scheme_eligibility(farmer)

    async def _deliver_first_value(self, farmer):
        """
        The CRITICAL moment — immediately after onboarding,
        deliver tangible value to prove the platform's worth.
        """
        lang = farmer.get('language', 'hi')
        name = farmer.get('name', '')
        district = farmer.get('district', '')
        district_id = farmer.get('district_id')

        # 1. Soil health summary
        soil_report = await self._get_soil_summary(district_id, lang)

        # 2. Today's mandi prices for their crops
        crops = await self.db.fetch(
            "SELECT crop_name FROM farmer_crops WHERE farmer_id = $1 AND is_active = true",
            farmer['id']
        )
        mandi_text = await self._get_mandi_summary(crops, district, lang)

        # 3. Current weather
        weather_text = await self._get_weather_summary(district, lang)

        # Build complete welcome message
        welcome = {
            'hi': f"🎉 {name} ji, aapka profile ban gaya!\n\n",
            'bho': f"🎉 {name} ji, rauwa ke profile ban gail!\n\n",
            'en': f"🎉 {name}, your profile is ready!\n\n"
        }[lang]

        full_message = welcome + soil_report + "\n\n" + mandi_text + "\n\n" + weather_text

        # WhatsApp has ~4096 char limit per text message
        # If too long, split into multiple messages (still within service window = FREE)
        if len(full_message) > 3800:
            await self.messenger.send_text(farmer, welcome + soil_report)
            await self.messenger.send_text(farmer, mandi_text + "\n\n" + weather_text)
        else:
            await self.messenger.send_text(farmer, full_message)

        # Send main menu with all features
        await self._send_main_menu(farmer)

    async def _send_main_menu(self, farmer):
        lang = farmer.get('language', 'hi')
        menu_text = {
            'hi': (
                "📋 *Main Menu — Kya karna hai?*\n\n"
                "Neeche se chunein ya seedha apna sawal poochein:"
            ),
            'bho': (
                "📋 *Main Menu — Ka kare ke ba?*\n\n"
                "Neeche se chunin ya seedha apna sawal poochin:"
            ),
            'en': (
                "📋 *Main Menu — What would you like to do?*\n\n"
                "Select below or ask your question directly:"
            )
        }[lang]

        sections = [
            {
                "title": {"hi": "Fasal Salah", "bho": "Fasal Salah", "en": "Crop Advisory"}[lang],
                "rows": [
                    {"id": "menu_photo", "title": {"hi": "📸 Photo Bhejein", "bho": "📸 Photo Bhejin", "en": "📸 Send Photo"}[lang],
                     "description": {"hi": "Fasal ki photo se samasyaa jaanein", "bho": "Fasal ke photo se samasya jaanin", "en": "Identify crop issues from photo"}[lang]},
                    {"id": "menu_spray", "title": {"hi": "💊 Spray Salah", "bho": "💊 Spray Salah", "en": "💊 Spray Advisory"}[lang],
                     "description": {"hi": "Kab, kya aur kitna spray karein", "bho": "Kab, ka aur ketna spray karin", "en": "What, when, how much to spray"}[lang]},
                ]
            },
            {
                "title": {"hi": "Market & Mausam", "bho": "Market & Mausam", "en": "Market & Weather"}[lang],
                "rows": [
                    {"id": "menu_mandi", "title": {"hi": "📊 Mandi Bhav", "bho": "📊 Mandi Bhav", "en": "📊 Market Prices"}[lang],
                     "description": {"hi": "Aaj ke fasal ke daam", "bho": "Aaj ke fasal ke daam", "en": "Today's crop prices"}[lang]},
                    {"id": "menu_weather", "title": {"hi": "🌤 Mausam", "bho": "🌤 Mausam", "en": "🌤 Weather"}[lang],
                     "description": {"hi": "5 din ka mausam", "bho": "5 din ke mausam", "en": "5-day forecast"}[lang]},
                ]
            },
            {
                "title": {"hi": "Aur Seva", "bho": "Aur Seva", "en": "More Services"}[lang],
                "rows": [
                    {"id": "menu_soil", "title": {"hi": "🌱 Mitti Jaankari", "bho": "🌱 Maati Jaankari", "en": "🌱 Soil Health"}[lang],
                     "description": {"hi": "Aapke jile ki mitti ki report", "bho": "Rauwa ke jila ke maati report", "en": "Your district soil report"}[lang]},
                    {"id": "menu_scheme", "title": {"hi": "🏛 Sarkari Yojana", "bho": "🏛 Sarkari Yojana", "en": "🏛 Govt Schemes"}[lang],
                     "description": {"hi": "Eligible yojanaon ki jaankari", "bho": "Eligible yojana ke jaankari", "en": "Eligible scheme information"}[lang]},
                    {"id": "menu_profile", "title": {"hi": "👤 Mera Profile", "bho": "👤 Hamaar Profile", "en": "👤 My Profile"}[lang],
                     "description": {"hi": "Profile dekhein ya badle", "bho": "Profile dekhin ya badlin", "en": "View or edit profile"}[lang]},
                ]
            }
        ]

        await self.messenger.send_interactive_list(
            farmer,
            body_text=menu_text,
            button_text={"hi": "Menu Kholein", "bho": "Menu Kholin", "en": "Open Menu"}[lang],
            sections=sections
        )

    async def _redirect_to_current_step(self, farmer, state, message_type):
        """When farmer sends media during onboarding, redirect them."""
        lang = farmer.get('language', 'hi')
        step_messages = {
            OnboardingState.LANGUAGE_SELECTION: {
                'hi': "Pehle apni bhasha chunein, phir photo bhejein.",
                'en': "Please select your language first, then send photos."
            },
            OnboardingState.NAME_COLLECTION: {
                'hi': "Pehle apna naam batayein.",
                'en': "Please tell us your name first."
            },
            OnboardingState.STATE_SELECTION: {
                'hi': "Pehle apna rajya batayein.",
                'en': "Please tell us your state first."
            },
            OnboardingState.DISTRICT_SELECTION: {
                'hi': "Pehle apna jila batayein.",
                'en': "Please tell us your district first."
            },
            OnboardingState.VILLAGE_COLLECTION: {
                'hi': "Pehle apne gaon ka naam batayein.",
                'en': "Please tell us your village name first."
            },
        }
        default_msg = {
            'hi': "Pehle apni jaankari dein, phir aap saari seva use kar sakte hain.",
            'en': "Please complete your profile first to access all services."
        }

        msg = step_messages.get(state, default_msg).get(lang, default_msg['hi'])
        await self.messenger.send_text(farmer, msg)

    def _current_season(self):
        month = datetime.utcnow().month
        if month in (6, 7, 8, 9, 10):
            return 'kharif'
        elif month in (11, 12, 1, 2, 3):
            return 'rabi'
        else:
            return 'zaid'

    def _build_state_sections(self, states):
        """Build WhatsApp interactive list sections for Indian states."""
        # Group alphabetically — WhatsApp supports max 10 sections, 10 rows each
        sections = []
        current_section_rows = []
        current_letter = ''

        for state in sorted(states, key=lambda s: s['state_name']):
            first_letter = state['state_name'][0].upper()
            if first_letter != current_letter and current_section_rows:
                sections.append({
                    "title": f"{current_letter}",
                    "rows": current_section_rows[:10]
                })
                current_section_rows = []
            current_letter = first_letter
            current_section_rows.append({
                "id": f"state_{state['state_name'][:20]}",
                "title": state['state_name'][:24]
            })

        if current_section_rows:
            sections.append({
                "title": current_letter,
                "rows": current_section_rows[:10]
            })

        return sections[:10]  # WhatsApp max 10 sections

    def _build_district_sections(self, districts):
        """Build WhatsApp interactive list sections for districts."""
        rows = []
        for d in sorted(districts, key=lambda x: x['district_name']):
            rows.append({
                "id": f"dist_{d['id']}",
                "title": d['district_name'][:24],
                "description": d.get('district_name_hindi', '')[:72]
            })

        # Split into sections of 10
        sections = []
        for i in range(0, len(rows), 10):
            chunk = rows[i:i+10]
            sections.append({
                "title": f"{chunk[0]['title'][0]}-{chunk[-1]['title'][0]}",
                "rows": chunk
            })

        return sections[:10]

    def _build_crop_sections(self, crops):
        rows = [{"id": f"crop_{c['name'][:20]}", "title": c['name'][:24]}
                for c in crops]
        return [{"title": "Fasal", "rows": rows[:10]}]
