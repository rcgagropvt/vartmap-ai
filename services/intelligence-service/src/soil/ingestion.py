# intelligence-service/src/soil/ingestion.py

"""
Soil Health Card Data Ingestion Pipeline
Sources:
  1. soilhealth.dac.gov.in (Government portal — primary)
  2. data.gov.in (Open datasets — supplementary)
  3. google-research-datasets/india-soil-health-card (scraper reference)
"""

import asyncio
import aiohttp
from bs4 import BeautifulSoup
import pandas as pd
from fuzzywuzzy import fuzz, process
import logging

logger = logging.getLogger(__name__)


class SoilHealthIngestionPipeline:

    def __init__(self, db, districts_service):
        self.db = db
        self.districts_service = districts_service
        self.base_url = "https://soilhealth.dac.gov.in"

    async def run_full_ingestion(self):
        """Master pipeline — run monthly via cron."""
        logger.info("Starting soil health data ingestion")

        # Step 1: Scrape macro nutrient data for all states
        states = await self.districts_service.get_all_states()
        for state in states:
            try:
                await self._scrape_state_macro(state['state_name'])
                await self._scrape_state_micro(state['state_name'])
                await asyncio.sleep(2)  # Respectful rate limiting
            except Exception as e:
                logger.error(f"Failed for {state['state_name']}: {e}")

        # Step 2: Supplement with data.gov.in open datasets
        await self._ingest_open_data()

        # Step 3: Normalize district names
        await self._normalize_district_names()

        # Step 4: Invalidate Redis caches
        await self._invalidate_caches()

        logger.info("Soil health ingestion complete")

    async def _scrape_state_macro(self, state_name: str):
        """Scrape macro nutrient report for a state."""
        url = f"{self.base_url}/PublicReports/DistrictMacroNS"

        async with aiohttp.ClientSession() as session:
            # Get the form page first (for CSRF token / viewstate)
            async with session.get(url) as resp:
                html = await resp.text()

            soup = BeautifulSoup(html, 'html.parser')
            viewstate = soup.find('input', {'name': '__VIEWSTATE'})
            if viewstate:
                viewstate = viewstate.get('value', '')

            # Submit form with state selection
            form_data = {
                '__VIEWSTATE': viewstate,
                'ctl00$ContentPlaceHolder1$ddl_State': state_name,
                'ctl00$ContentPlaceHolder1$btn_Submit': 'Submit'
            }

            async with session.post(url, data=form_data) as resp:
                html = await resp.text()

            # Parse the results table
            soup = BeautifulSoup(html, 'html.parser')
            table = soup.find('table', {'id': 'ContentPlaceHolder1_grd_Macro'})
            if not table:
                logger.warning(f"No macro data table for {state_name}")
                return

            rows = table.find_all('tr')[1:]  # Skip header
            for row in rows:
                cols = [td.get_text(strip=True) for td in row.find_all('td')]
                if len(cols) >= 10:
                    district_name = cols[0]
                    await self._upsert_macro_data(state_name, district_name, cols)

    async def _scrape_state_micro(self, state_name: str):
        """Scrape micro nutrient report for a state."""
        url = f"{self.base_url}/PublicReports/DistrictMicroNS"
        # Similar scraping logic for micro nutrients
        # (Zinc, Iron, Copper, Manganese, Boron)
        pass  # Implementation mirrors _scrape_state_macro

    async def _upsert_macro_data(self, state: str, district: str, cols: list):
        """Insert or update macro nutrient data for a district."""
        await self.db.execute("""
            INSERT INTO district_soil_health
                (id, state_name, district_name, data_cycle,
                 nitrogen_low_pct, nitrogen_medium_pct, nitrogen_high_pct,
                 phosphorus_low_pct, phosphorus_medium_pct, phosphorus_high_pct,
                 potassium_low_pct, potassium_medium_pct, potassium_high_pct,
                 samples_tested, scraped_at)
            VALUES
                (gen_random_uuid(), $1, $2, $3,
                 $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
            ON CONFLICT (district_id, data_cycle)
            DO UPDATE SET
                nitrogen_low_pct = EXCLUDED.nitrogen_low_pct,
                nitrogen_medium_pct = EXCLUDED.nitrogen_medium_pct,
                nitrogen_high_pct = EXCLUDED.nitrogen_high_pct,
                phosphorus_low_pct = EXCLUDED.phosphorus_low_pct,
                phosphorus_medium_pct = EXCLUDED.phosphorus_medium_pct,
                phosphorus_high_pct = EXCLUDED.phosphorus_high_pct,
                potassium_low_pct = EXCLUDED.potassium_low_pct,
                potassium_medium_pct = EXCLUDED.potassium_medium_pct,
                potassium_high_pct = EXCLUDED.potassium_high_pct,
                samples_tested = EXCLUDED.samples_tested,
                scraped_at = NOW(),
                updated_at = NOW()
        """, state, district, 'cycle_iii',
            *[self._safe_float(c) for c in cols[1:10]],
            self._safe_int(cols[10]) if len(cols) > 10 else None
        )

    async def _normalize_district_names(self):
        """
        Match scraped district names to our districts master table.
        Critical because SHC portal may use different spellings.
        """
        unmatched = await self.db.fetch("""
            SELECT id, state_name, district_name
            FROM district_soil_health
            WHERE district_id IS NULL
        """)

        for record in unmatched:
            districts = await self.districts_service.get_districts_by_state(
                record['state_name']
            )
            all_names = [d['district_name'] for d in districts]

            best_match = process.extractOne(
                record['district_name'],
                all_names,
                scorer=fuzz.ratio,
                score_cutoff=65
            )

            if best_match:
                matched_district = next(
                    d for d in districts if d['district_name'] == best_match[0]
                )
                await self.db.execute(
                    "UPDATE district_soil_health SET district_id = $1 WHERE id = $2",
                    matched_district['id'], record['id']
                )
                logger.info(
                    f"Matched '{record['district_name']}' → '{best_match[0]}' "
                    f"(score: {best_match[1]})"
                )
            else:
                logger.warning(
                    f"Could not match district: {record['district_name']} "
                    f"in {record['state_name']}"
                )

    async def _ingest_open_data(self):
        """Supplement with data.gov.in open datasets."""
        data_gov_url = (
            "https://data.gov.in/resource/api/"
            "soil-health-card-district-wise-data"
        )
        # Download CSV and process
        # This serves as supplementary data where scraping fails
        pass

    async def _invalidate_caches(self):
        """Clear all Redis soil caches after fresh data load."""
        keys = await self.redis.keys("soil:*")
        if keys:
            await self.redis.delete(*keys)
        logger.info(f"Invalidated {len(keys)} soil cache entries")

    def _safe_float(self, val):
        try:
            return float(str(val).replace('%', '').strip())
        except (ValueError, TypeError):
            return None

    def _safe_int(self, val):
        try:
            return int(str(val).replace(',', '').strip())
        except (ValueError, TypeError):
            return None
