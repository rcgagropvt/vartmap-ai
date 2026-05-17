
// ============================================
// WEATHER-BASED PEST & DISEASE PREDICTION ENGINE
// Based on ICAR-NCIPM validated threshold models
// ============================================

const OPENWEATHER_API_KEY = process.env.OPENWEATHER_API_KEY || ''; // Set in Render env

// Prediction rules from ICAR-NCIPM Technical Bulletin 39 and IMD Agromet Advisory
const PEST_RULES = {
  // ===== RICE PESTS =====
  rice_stem_borer: {
    name: 'Yellow Stem Borer',
    nameHi: 'पीला तना छेदक',
    crop: 'Rice',
    type: 'pest',
    category: 'Lepidoptera',
    season: ['kharif', 'zaid'],
    criteria: {
      tmax: [30, 34],
      tmin: [22, 25],
      humidity: [85, 95],
      rainfall_max: 10,
      sunshine: [5, 9]
    },
    thresholdCount: { high: 4, moderate: 3, low: 2 },
    symptoms: [
      'Dead hearts - central shoot dries up during vegetative stage',
      'White ears - panicles turn white at reproductive stage',
      'Bore holes at base of plant with frass'
    ],
    management: {
      chemical: 'Cartap Hydrochloride 4G @ 25 kg/ha OR Chlorantraniliprole 0.4G @ 10 kg/ha',
      biological: 'Release Trichogramma japonicum @ 1 lakh/ha at weekly intervals',
      cultural: 'Clip seedling tips before transplanting, destroy stubbles after harvest'
    },
    severity_impact: { high: '25-30% yield loss', moderate: '10-15% yield loss', low: '<5% yield loss' }
  },
  rice_leaf_folder: {
    name: 'Leaf Folder',
    nameHi: 'पत्ती लपेटक',
    crop: 'Rice',
    type: 'pest',
    category: 'Lepidoptera',
    season: ['kharif'],
    criteria: {
      tmax: [30, 34],
      tmin: [20, 24],
      humidity: [88, 94],
      rainfall_max: 10,
      sunshine: [6, 9]
    },
    thresholdCount: { high: 4, moderate: 3, low: 2 },
    symptoms: [
      'Leaves folded longitudinally with silk strands',
      'White transparent streaks on leaf blade',
      'Papery/whitish appearance in severe cases'
    ],
    management: {
      chemical: 'Fipronil 5SC @ 1.5 ml/L OR Cartap Hydrochloride 50SP @ 1 g/L',
      biological: 'Conserve spider populations, avoid broad-spectrum insecticides',
      cultural: 'Avoid excessive nitrogen, maintain recommended spacing'
    },
    severity_impact: { high: '30-40% leaf area damage', moderate: '15-20% leaf area damage', low: '<10% leaf area damage' }
  },
  rice_brown_planthopper: {
    name: 'Brown Plant Hopper (BPH)',
    nameHi: 'भूरा माहू',
    crop: 'Rice',
    type: 'pest',
    category: 'Hemiptera',
    season: ['kharif', 'zaid'],
    criteria: {
      tmax: [30, 34],
      tmin: [22, 26],
      humidity: [80, 92],
      humidity_evening: [40, 65],
      rainfall_max: 10
    },
    thresholdCount: { high: 4, moderate: 3, low: 2 },
    symptoms: [
      'Hopper burn - circular patches of dried plants',
      'Plants turn orange-yellow then brown',
      'Honeydew deposits at plant base, sooty mold growth'
    ],
    management: {
      chemical: 'Pymetrozine 50WG @ 0.6 g/L OR Dinotefuran 20SG @ 0.5 g/L (avoid synthetic pyrethroids)',
      biological: 'Conserve Lycosa pseudoannulata spiders, Cyrtorhinus lividipennis mirid bug',
      cultural: 'Drain water periodically, avoid continuous flooding, use resistant varieties (Ratna, Ptb 33)'
    },
    severity_impact: { high: '50-100% crop loss (hopperburn)', moderate: '15-30% yield reduction', low: '<10% yield reduction' }
  },
  rice_blast: {
    name: 'Rice Blast',
    nameHi: 'चावल का ब्लास्ट',
    crop: 'Rice',
    type: 'disease',
    category: 'Fungal (Magnaporthe oryzae)',
    season: ['kharif', 'rabi', 'zaid'],
    criteria: {
      tmax: [25, 30],
      tmin: [20, 26],
      humidity: [90, 100],
      rainfall_min: 5,
      cloudy_days: true
    },
    thresholdCount: { high: 4, moderate: 3, low: 2 },
    symptoms: [
      'Diamond/spindle-shaped spots with grey center and brown margin on leaves',
      'Neck rot - panicle base turns brown and breaks',
      'Node blast - black lesions on nodes'
    ],
    management: {
      chemical: 'Tricyclazole 75WP @ 0.6 g/L OR Isoprothiolane 40EC @ 1.5 ml/L',
      biological: 'Pseudomonas fluorescens @ 5g/L seed treatment + foliar spray',
      cultural: 'Use resistant varieties, balanced fertilization (avoid excess N), maintain 2-3 cm water'
    },
    severity_impact: { high: '50-90% yield loss in severe epidemics', moderate: '20-40% yield loss', low: '<10% yield loss' }
  },
  rice_sheath_blight: {
    name: 'Sheath Blight',
    nameHi: 'शीथ ब्लाइट',
    crop: 'Rice',
    type: 'disease',
    category: 'Fungal (Rhizoctonia solani)',
    season: ['kharif'],
    criteria: {
      tmax: [28, 34],
      tmin: [22, 26],
      humidity: [85, 100],
      rainfall_max: 20
    },
    thresholdCount: { high: 3, moderate: 2, low: 1 },
    symptoms: [
      'Oval/irregular greenish-grey water-soaked lesions on leaf sheath near water line',
      'Lesions enlarge and coalesce, sheath turns brown',
      'White mycelium and small brown sclerotia on lesions'
    ],
    management: {
      chemical: 'Hexaconazole 5EC @ 2 ml/L OR Validamycin 3L @ 2.5 ml/L',
      biological: 'Trichoderma viride @ 5g/L foliar spray',
      cultural: 'Avoid dense planting, reduce nitrogen, remove sclerotia from field water'
    },
    severity_impact: { high: '25-50% yield loss', moderate: '10-20% yield loss', low: '<5% yield loss' }
  },

  // ===== WHEAT PESTS =====
  wheat_aphid: {
    name: 'Wheat Aphid',
    nameHi: 'गेहूं का माहू',
    crop: 'Wheat',
    type: 'pest',
    category: 'Hemiptera',
    season: ['rabi', 'zaid'],
    criteria: {
      tmax: [20, 28],
      tmin: [8, 15],
      humidity: [60, 80],
      rainfall_max: 5,
      wind_speed_max: 8
    },
    thresholdCount: { high: 4, moderate: 3, low: 2 },
    symptoms: [
      'Colonies on leaves, stems and ears sucking sap',
      'Yellowing and curling of leaves',
      'Honeydew secretion with sooty mold, reduced grain filling'
    ],
    management: {
      chemical: 'Imidacloprid 17.8SL @ 0.3 ml/L OR Thiamethoxam 25WG @ 0.5 g/L',
      biological: 'Conserve ladybird beetles (Coccinella septempunctata), lacewings, syrphid flies',
      cultural: 'Timely sowing (avoid late sowing), avoid excess nitrogen, use resistant varieties (WH542, HD2967)'
    },
    severity_impact: { high: '20-40% yield loss', moderate: '10-15% yield loss', low: '<5% yield loss' }
  },
  wheat_rust: {
    name: 'Wheat Rust (Brown/Yellow)',
    nameHi: 'गेहूं का रतुआ',
    crop: 'Wheat',
    type: 'disease',
    category: 'Fungal (Puccinia spp.)',
    season: ['rabi'],
    criteria: {
      tmax: [15, 25],
      tmin: [5, 15],
      humidity: [80, 100],
      dew_hours: true
    },
    thresholdCount: { high: 3, moderate: 2, low: 1 },
    symptoms: [
      'Orange-brown (brown rust) or yellow (stripe rust) pustules on leaves',
      'Pustules arranged in stripes for yellow rust',
      'Premature drying of leaves, shriveled grains'
    ],
    management: {
      chemical: 'Propiconazole 25EC @ 1 ml/L (2 sprays at 15 day interval)',
      biological: 'Not very effective for rust, rely on resistant varieties',
      cultural: 'Grow resistant varieties (HD3086, DBW187), timely sowing, balanced nutrition'
    },
    severity_impact: { high: '30-70% yield loss', moderate: '10-25% yield loss', low: '<5% yield loss' }
  },
  wheat_karnal_bunt: {
    name: 'Karnal Bunt',
    nameHi: 'करनाल बंट',
    crop: 'Wheat',
    type: 'disease',
    category: 'Fungal (Tilletia indica)',
    season: ['rabi'],
    criteria: {
      tmax: [20, 26],
      tmin: [12, 18],
      humidity: [70, 90],
      rainfall_min: 2,
      cloudy_days: true
    },
    thresholdCount: { high: 4, moderate: 3, low: 2 },
    symptoms: [
      'Fishy smell from infected grains',
      'Partially or fully converted bunted grains with black powder',
      'Visible at harvest, mainly at ear emergence stage'
    ],
    management: {
      chemical: 'Propiconazole 25EC @ 1 ml/L at boot leaf stage (flag leaf) if conditions favorable',
      biological: 'Seed treatment with Trichoderma viride @ 4g/kg seed',
      cultural: 'Seed treatment with Carboxin 75WP @ 2.5g/kg, avoid late sowing, use certified seed'
    },
    severity_impact: { high: '20-40% grain downgraded', moderate: '5-15% grain affected', low: '<3% grain affected' }
  },

  // ===== POTATO PESTS =====
  potato_late_blight: {
    name: 'Late Blight',
    nameHi: 'आलू का पछेता झुलसा',
    crop: 'Potato',
    type: 'disease',
    category: 'Oomycete (Phytophthora infestans)',
    season: ['rabi', 'kharif'],
    criteria: {
      tmax: [15, 28],
      tmin: [5, 15],
      humidity: [80, 100],
      rainfall_min: 1,
      consecutive_wet_hours: 10
    },
    thresholdCount: { high: 4, moderate: 3, low: 2 },
    symptoms: [
      'Water-soaked dark green to brown lesions on leaf margins',
      'White fluffy growth on underside of leaves in moist conditions',
      'Rapid blighting of entire foliage in 3-5 days, rotten tubers'
    ],
    management: {
      chemical: 'Mancozeb 75WP @ 2.5 g/L (preventive) OR Cymoxanil+Mancozeb @ 3 g/L (curative)',
      biological: 'Bio-agent Trichoderma harzianum soil application',
      cultural: 'Use disease-free seed, avoid low-lying fields, earthing up, proper drainage'
    },
    severity_impact: { high: '60-100% crop destruction in 7-10 days', moderate: '20-40% foliage damage', low: '<10% leaf infection' }
  },
  potato_aphid: {
    name: 'Potato Aphid',
    nameHi: 'आलू का माहू',
    crop: 'Potato',
    type: 'pest',
    category: 'Hemiptera (Myzus persicae)',
    season: ['rabi'],
    criteria: {
      tmax: [18, 28],
      tmin: [5, 15],
      humidity: [50, 75],
      wind_speed_max: 10
    },
    thresholdCount: { high: 3, moderate: 2, low: 1 },
    symptoms: [
      'Colonies on underside of leaves, curling of top leaves',
      'Yellowing and stunting of plants',
      'Honeydew with sooty mold, transmits viruses (PVY, PLRV)'
    ],
    management: {
      chemical: 'Imidacloprid 17.8SL @ 0.3 ml/L OR Acetamiprid 20SP @ 0.3 g/L',
      biological: 'Release Chrysoperla carnea @ 50,000/ha',
      cultural: 'Early dehaulming (cut tops) 10 days before harvest to prevent virus spread'
    },
    severity_impact: { high: 'Virus spread >40% plants', moderate: '15-25% plants infested', low: '<10% infestation' }
  },

  // ===== SUGARCANE =====
  sugarcane_shoot_borer: {
    name: 'Shoot Borer',
    nameHi: 'गन्ना शूट बोरर',
    crop: 'Sugarcane',
    type: 'pest',
    category: 'Lepidoptera (Chilo infuscatellus)',
    season: ['kharif', 'zaid'],
    criteria: {
      tmax: [30, 38],
      tmin: [22, 28],
      humidity: [70, 85],
      rainfall_max: 15
    },
    thresholdCount: { high: 3, moderate: 2, low: 1 },
    symptoms: [
      'Dead heart in young shoots (central whorl dries)',
      'Bore holes with frass at nodes',
      'Shoots pull out easily'
    ],
    management: {
      chemical: 'Fipronil 0.3G @ 25 kg/ha in soil around root zone',
      biological: 'Release Trichogramma chilonis @ 50,000/ha at 15 day interval (5 releases)',
      cultural: 'Light earthing up, detrashing, intercropping with mustard'
    },
    severity_impact: { high: '25-35% dead hearts', moderate: '10-20% dead hearts', low: '<10% dead hearts' }
  },
  sugarcane_red_rot: {
    name: 'Red Rot',
    nameHi: 'गन्ना लाल सड़न',
    crop: 'Sugarcane',
    type: 'disease',
    category: 'Fungal (Colletotrichum falcatum)',
    season: ['kharif'],
    criteria: {
      tmax: [28, 35],
      tmin: [22, 28],
      humidity: [85, 100],
      rainfall_min: 20
    },
    thresholdCount: { high: 3, moderate: 2, low: 1 },
    symptoms: [
      'Yellowing and drying of leaves from top downwards',
      'Red discoloration inside cane with white transverse patches',
      'Foul smell from split canes, poor juice quality'
    ],
    management: {
      chemical: 'Sett treatment with Carbendazim 50WP @ 2g/L for 30 minutes',
      biological: 'Trichoderma viride sett treatment @ 5g/L',
      cultural: 'Use disease-free setts, grow resistant varieties (Co 0238), avoid waterlogging'
    },
    severity_impact: { high: '50-100% crop loss', moderate: '20-40% affected stalks', low: '<10% affected' }
  },

  // ===== COTTON =====
  cotton_bollworm: {
    name: 'American Bollworm',
    nameHi: 'कपास की अमेरिकन सुंडी',
    crop: 'Cotton',
    type: 'pest',
    category: 'Lepidoptera (Helicoverpa armigera)',
    season: ['kharif', 'zaid'],
    criteria: {
      tmax: [28, 35],
      tmin: [18, 25],
      humidity: [60, 80],
      rainfall_max: 25,
      wind_speed_max: 10
    },
    thresholdCount: { high: 4, moderate: 3, low: 2 },
    symptoms: [
      'Bore holes in squares, flowers and bolls',
      'Frass (excreta) at entry point',
      'Premature shedding of squares and young bolls'
    ],
    management: {
      chemical: 'Emamectin Benzoate 5SG @ 0.4 g/L OR NPV HaNPV @ 250 LE/ha (evening spray)',
      biological: 'Install pheromone traps @ 5/ha, release Trichogramma chilonis @ 1.5 lakh/ha',
      cultural: 'Grow trap crops (pigeon pea, marigold), hand pick and destroy larvae'
    },
    severity_impact: { high: '30-60% boll damage', moderate: '10-25% boll damage', low: '<10% damage' }
  },
  cotton_jassid: {
    name: 'Cotton Jassid',
    nameHi: 'कपास का हरा तेला',
    crop: 'Cotton',
    type: 'pest',
    category: 'Hemiptera (Amrasca biguttula)',
    season: ['kharif', 'zaid'],
    criteria: {
      tmax: [25, 33],
      tmin: [20, 26],
      humidity: [65, 85],
      rainfall_range: [50, 80],
      rainy_days_range: [2, 4]
    },
    thresholdCount: { high: 4, moderate: 3, low: 2 },
    symptoms: [
      'Leaf curling downwards (cup-shaped) from margins',
      'Yellowing of leaf margins (hopper burn)',
      'Nymphs and adults on underside of leaves'
    ],
    management: {
      chemical: 'Acetamiprid 20SP @ 0.2 g/L OR Flonicamid 50WG @ 0.3 g/L',
      biological: 'Conserve Chrysoperla (green lacewing), avoid broad-spectrum sprays',
      cultural: 'Grow resistant varieties with hairy leaves, neem oil spray @ 5ml/L'
    },
    severity_impact: { high: '>8 jassids/3 leaves, significant yield loss', moderate: '4-8 per 3 leaves', low: '<4 per 3 leaves' }
  },

  // ===== PULSES =====
  pigeonpea_pod_borer: {
    name: 'Pod Borer (Gram/Arhar)',
    nameHi: 'फली छेदक',
    crop: 'Pigeon Pea',
    altCrops: ['Gram', 'Chickpea', 'Arhar', 'Toor'],
    type: 'pest',
    category: 'Lepidoptera (Helicoverpa armigera)',
    season: ['rabi', 'kharif'],
    criteria: {
      tmax: [25, 32],
      tmin: [12, 22],
      humidity: [50, 75],
      rainfall_max: 10
    },
    thresholdCount: { high: 3, moderate: 2, low: 1 },
    symptoms: [
      'Bore holes in pods, larva feeds on developing grains',
      'Frass at pod entry points',
      'Premature pod drop, empty/partially filled pods'
    ],
    management: {
      chemical: 'HaNPV @ 250 LE/ha (evening) + 0.1% jaggery OR Indoxacarb 14.5SC @ 0.5 ml/L',
      biological: 'Install pheromone traps early, bird perches @ 20/ha, Trichogramma release',
      cultural: 'Intercrop with coriander/linseed, deep summer ploughing, hand collection of larvae'
    },
    severity_impact: { high: '30-50% pod damage', moderate: '10-25% pod damage', low: '<10% pod damage' }
  },

  // ===== MUSTARD =====
  mustard_aphid: {
    name: 'Mustard Aphid',
    nameHi: 'सरसों का माहू',
    crop: 'Mustard',
    altCrops: ['Sarso', 'Rapeseed'],
    type: 'pest',
    category: 'Hemiptera (Lipaphis erysimi)',
    season: ['rabi', 'zaid'],
    criteria: {
      tmax: [18, 25],
      tmin: [4, 12],
      humidity: [60, 80],
      wind_speed_max: 8,
      cloudy_days: true
    },
    thresholdCount: { high: 4, moderate: 3, low: 2 },
    symptoms: [
      'Dense colonies on shoots, inflorescence and pods',
      'Curling and wilting of inflorescence',
      'Honeydew + sooty mold, poor seed set'
    ],
    management: {
      chemical: 'Dimethoate 30EC @ 1 ml/L OR Imidacloprid 17.8SL @ 0.3 ml/L',
      biological: 'Conserve Coccinellid beetles (Coccinella septempunctata), parasitoid Diaeretiella rapae',
      cultural: 'Early sowing (before 25 Oct), mustard + wheat intercropping, yellow sticky traps'
    },
    severity_impact: { high: '35-75% yield loss', moderate: '15-30% yield loss', low: '<10% yield loss' }
  },

  // ===== TOMATO =====
  tomato_early_blight: {
    name: 'Early Blight',
    nameHi: 'टमाटर का अगेता झुलसा',
    crop: 'Tomato',
    altCrops: ['Tamatar'],
    type: 'disease',
    category: 'Fungal (Alternaria solani)',
    season: ['kharif', 'rabi', 'zaid'],
    criteria: {
      tmax: [25, 32],
      tmin: [15, 22],
      humidity: [80, 95],
      rainfall_min: 3
    },
    thresholdCount: { high: 3, moderate: 2, low: 1 },
    symptoms: [
      'Concentric ring-shaped brown spots on lower leaves (target spot)',
      'Spots enlarge, leaves yellow and drop prematurely',
      'Dark sunken lesions on stem, collar rot in seedlings'
    ],
    management: {
      chemical: 'Mancozeb 75WP @ 2.5 g/L OR Chlorothalonil 75WP @ 2 g/L (spray at 10-day interval)',
      biological: 'Trichoderma harzianum seed/soil treatment',
      cultural: 'Crop rotation (3 year), remove infected debris, proper spacing for air circulation'
    },
    severity_impact: { high: '50-80% defoliation, poor fruit', moderate: '20-40% leaf infection', low: '<15% leaves affected' }
  },
  tomato_fruit_borer: {
    name: 'Tomato Fruit Borer',
    nameHi: 'टमाटर की फल छेदक',
    crop: 'Tomato',
    altCrops: ['Tamatar'],
    type: 'pest',
    category: 'Lepidoptera (Helicoverpa armigera)',
    season: ['kharif', 'rabi', 'zaid'],
    criteria: {
      tmax: [25, 33],
      tmin: [15, 24],
      humidity: [50, 75],
      rainfall_max: 15
    },
    thresholdCount: { high: 3, moderate: 2, low: 1 },
    symptoms: [
      'Circular bore holes in green and ripe fruits',
      'Larva feeds inside fruit causing rot',
      'Frass near hole, fruit drops prematurely'
    ],
    management: {
      chemical: 'Spinosad 45SC @ 0.5 ml/L OR Chlorantraniliprole 18.5SC @ 0.3 ml/L',
      biological: 'HaNPV 250 LE/ha evening spray, Trichogramma pretiosum release',
      cultural: 'Pheromone traps, marigold as trap crop, collection and destruction of infested fruits'
    },
    severity_impact: { high: '30-50% fruit damage', moderate: '10-25% fruit damage', low: '<10% fruit damage' }
  },

  // ===== ONION =====
  onion_thrips: {
    name: 'Onion Thrips',
    nameHi: 'प्याज का थ्रिप्स',
    crop: 'Onion',
    altCrops: ['Pyaz'],
    type: 'pest',
    category: 'Thysanoptera (Thrips tabaci)',
    season: ['rabi', 'kharif', 'zaid'],
    criteria: {
      tmax: [28, 38],
      tmin: [15, 25],
      humidity: [40, 65],
      rainfall_max: 5,
      dry_spell: true
    },
    thresholdCount: { high: 4, moderate: 3, low: 2 },
    symptoms: [
      'Silvery white patches/streaks on leaves',
      'Leaf tips turn brown and curl',
      'Stunted bulb growth in severe cases'
    ],
    management: {
      chemical: 'Fipronil 5SC @ 1.5 ml/L OR Spinetoram 11.7SC @ 0.5 ml/L (alternate sprays)',
      biological: 'Neem oil 1500 ppm @ 5 ml/L at initial stage',
      cultural: 'Overhead sprinkler irrigation reduces thrips, intercrop with coriander'
    },
    severity_impact: { high: '30-50% yield reduction', moderate: '15-25% yield reduction', low: '<10% reduction' }
  },

  // ===== MAIZE =====
  maize_fall_armyworm: {
    name: 'Fall Armyworm',
    nameHi: 'मक्का का सैनिक कीट',
    crop: 'Maize',
    altCrops: ['Makka'],
    type: 'pest',
    category: 'Lepidoptera (Spodoptera frugiperda)',
    season: ['kharif', 'rabi', 'zaid'],
    criteria: {
      tmax: [26, 35],
      tmin: [18, 26],
      humidity: [60, 85],
      rainfall_max: 30
    },
    thresholdCount: { high: 3, moderate: 2, low: 1 },
    symptoms: [
      'Ragged/window-pane feeding on whorl leaves',
      'Large amount of frass in the whorl',
      'Young larvae scrape leaves, older ones defoliate heavily'
    ],
    management: {
      chemical: 'Emamectin Benzoate 5SG @ 0.4 g/L OR Chlorantraniliprole 18.5SC @ 0.4 ml/L directed at whorl',
      biological: 'Spray 5% NSKE (neem seed kernel extract), release Telenomus remus egg parasitoid',
      cultural: 'Install pheromone traps, intercrop with pulses, apply sand+lime in whorl at early stage'
    },
    severity_impact: { high: '40-70% leaf damage, cob damage', moderate: '15-35% leaf damage', low: '<15% leaf damage' }
  },

  // ===== SOYBEAN =====
  soybean_girdle_beetle: {
    name: 'Girdle Beetle',
    nameHi: 'सोयाबीन का गर्डल बीटल',
    crop: 'Soybean',
    type: 'pest',
    category: 'Coleoptera (Obereopsis brevis)',
    season: ['kharif', 'zaid'],
    criteria: {
      tmax: [28, 33],
      tmin: [20, 25],
      humidity: [75, 90],
      rainfall_range: [20, 60]
    },
    thresholdCount: { high: 3, moderate: 2, low: 1 },
    symptoms: [
      'Ring-like girdling on stem/petiole',
      'Affected parts droop and dry above the girdle',
      'Larvae bore inside stem below girdle'
    ],
    management: {
      chemical: 'Triazophos 40EC @ 2 ml/L OR Profenophos 50EC @ 2 ml/L at flowering',
      biological: 'Collect and destroy girdled plant parts to kill larvae inside',
      cultural: 'Intercrop with sorghum or maize border rows, timely sowing'
    },
    severity_impact: { high: '25-40% yield loss', moderate: '10-20% yield loss', low: '<10% yield loss' }
  }
};

/**
 * Evaluate weather conditions against pest rules
 * Returns risk score and satisfied criteria count
 */
function evaluateRisk(weatherData, rule) {
  const criteria = rule.criteria;
  let satisfiedCount = 0;
  let totalCriteria = 0;
  const details = [];

  // Temperature Max check
  if (criteria.tmax) {
    totalCriteria++;
    if (weatherData.temp_max >= criteria.tmax[0] && weatherData.temp_max <= criteria.tmax[1]) {
      satisfiedCount++;
      details.push(`Max temp ${weatherData.temp_max.toFixed(1)}°C in favorable range (${criteria.tmax[0]}-${criteria.tmax[1]}°C)`);
    }
  }

  // Temperature Min check
  if (criteria.tmin) {
    totalCriteria++;
    if (weatherData.temp_min >= criteria.tmin[0] && weatherData.temp_min <= criteria.tmin[1]) {
      satisfiedCount++;
      details.push(`Min temp ${weatherData.temp_min.toFixed(1)}°C in favorable range (${criteria.tmin[0]}-${criteria.tmin[1]}°C)`);
    }
  }

  // Humidity check
  if (criteria.humidity) {
    totalCriteria++;
    if (weatherData.humidity >= criteria.humidity[0] && weatherData.humidity <= criteria.humidity[1]) {
      satisfiedCount++;
      details.push(`Humidity ${weatherData.humidity}% in favorable range (${criteria.humidity[0]}-${criteria.humidity[1]}%)`);
    }
  }

  // Rainfall max check (low rainfall favorable)
  if (criteria.rainfall_max !== undefined) {
    totalCriteria++;
    if (weatherData.rainfall <= criteria.rainfall_max) {
      satisfiedCount++;
      details.push(`Rainfall ${weatherData.rainfall.toFixed(1)}mm ≤ ${criteria.rainfall_max}mm (favorable dry conditions)`);
    }
  }

  // Rainfall min check (wet conditions favorable)
  if (criteria.rainfall_min !== undefined) {
    totalCriteria++;
    if (weatherData.rainfall >= criteria.rainfall_min) {
      satisfiedCount++;
      details.push(`Rainfall ${weatherData.rainfall.toFixed(1)}mm ≥ ${criteria.rainfall_min}mm (favorable wet conditions)`);
    }
  }

  // Determine severity
  let severity = 'low';
  let riskScore = 0;
  if (satisfiedCount >= rule.thresholdCount.high) {
    severity = 'high';
    riskScore = 85 + Math.min(15, (satisfiedCount - rule.thresholdCount.high) * 5);
  } else if (satisfiedCount >= rule.thresholdCount.moderate) {
    severity = 'moderate';
    riskScore = 50 + Math.min(34, (satisfiedCount - rule.thresholdCount.moderate) * 12);
  } else if (satisfiedCount >= rule.thresholdCount.low) {
    severity = 'low';
    riskScore = 20 + Math.min(29, (satisfiedCount - rule.thresholdCount.low) * 10);
  } else {
    severity = 'none';
    riskScore = Math.max(0, satisfiedCount * 8);
  }

  return { severity, riskScore, satisfiedCount, totalCriteria, details };
}

/**
 * Fetch 5-day weather forecast from OpenWeatherMap
 */
async function getWeatherForecast(lat, lon) {
  const apiKey = OPENWEATHER_API_KEY;
  if (!apiKey) {
    // Return simulated weather based on season and general India climate
    return getEstimatedWeather(lat);
  }
  
  try {
    const url = `https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&appid=${apiKey}&units=metric`;
    const response = await fetch(url);
    if (!response.ok) throw new Error('Weather API failed');
    const data = await response.json();
    
    // Aggregate into daily summaries
    const dailySummaries = {};
    for (const item of data.list) {
      const date = item.dt_txt.split(' ')[0];
      if (!dailySummaries[date]) {
        dailySummaries[date] = { temps: [], humidity: [], rainfall: 0 };
      }
      dailySummaries[date].temps.push(item.main.temp);
      dailySummaries[date].humidity.push(item.main.humidity);
      if (item.rain && item.rain['3h']) {
        dailySummaries[date].rainfall += item.rain['3h'];
      }
    }
    
    // Average across all forecast days
    const allTemps = Object.values(dailySummaries).flatMap(d => d.temps);
    const allHumidity = Object.values(dailySummaries).flatMap(d => d.humidity);
    const totalRainfall = Object.values(dailySummaries).reduce((sum, d) => sum + d.rainfall, 0);
    const days = Object.keys(dailySummaries).length || 1;
    
    return {
      temp_max: Math.max(...allTemps),
      temp_min: Math.min(...allTemps),
      temp_avg: allTemps.reduce((a, b) => a + b, 0) / allTemps.length,
      humidity: Math.round(allHumidity.reduce((a, b) => a + b, 0) / allHumidity.length),
      rainfall: totalRainfall / days,
      wind_speed: 5, // default
      forecast_days: days,
      source: 'openweathermap'
    };
  } catch (err) {
    console.error('Weather API error:', err.message);
    return getEstimatedWeather(lat);
  }
}

/**
 * Estimate weather when API key not available (based on season + latitude)
 */
function getEstimatedWeather(lat) {
  const month = new Date().getMonth() + 1;
  // India seasonal patterns
  let temp_max, temp_min, humidity, rainfall;
  
  if (month >= 6 && month <= 9) { // Monsoon
    temp_max = lat > 25 ? 34 : 32;
    temp_min = lat > 25 ? 25 : 23;
    humidity = 82;
    rainfall = 15;
  } else if (month >= 10 && month <= 11) { // Post-monsoon
    temp_max = lat > 25 ? 30 : 31;
    temp_min = lat > 25 ? 16 : 20;
    humidity = 65;
    rainfall = 3;
  } else if (month >= 12 || month <= 2) { // Winter
    temp_max = lat > 25 ? 22 : 28;
    temp_min = lat > 25 ? 7 : 15;
    humidity = 70;
    rainfall = 1;
  } else { // Summer (Mar-May)
    temp_max = lat > 25 ? 38 : 36;
    temp_min = lat > 25 ? 22 : 24;
    humidity = 40;
    rainfall = 2;
  }
  
  return { temp_max, temp_min, temp_avg: (temp_max + temp_min) / 2, humidity, rainfall, wind_speed: 6, forecast_days: 5, source: 'estimated' };
}

/**
 * Get current season
 */
function getCurrentSeason() {
  const month = new Date().getMonth() + 1;
  if (month >= 6 && month <= 10) return 'kharif';
  if (month >= 11 || month <= 3) return 'rabi';
  return 'zaid';
}

/**
 * Main prediction function
 */
async function getPestAlerts(lat, lon, farmerCrops = []) {
  const weather = await getWeatherForecast(lat, lon);
  const currentSeason = getCurrentSeason();
  
  const alerts = [];
  const normalizedCrops = farmerCrops.map(c => c.toLowerCase().trim());
  
  for (const [key, rule] of Object.entries(PEST_RULES)) {
    // Check if pest is relevant to current season
    if (!rule.season.includes(currentSeason)) continue;
    
    // Check if farmer grows this crop (if crops specified, filter)
    if (normalizedCrops.length > 0) {
      const cropMatch = normalizedCrops.some(fc => {
        const ruleCrop = rule.crop.toLowerCase();
        const altCrops = (rule.altCrops || []).map(a => a.toLowerCase());
        return fc.includes(ruleCrop) || ruleCrop.includes(fc) || altCrops.some(a => fc.includes(a) || a.includes(fc));
      });
      if (!cropMatch) continue;
    }
    
    // Evaluate risk
    const result = evaluateRisk(weather, rule);
    
    if (result.severity !== 'none') {
      alerts.push({
        id: key,
        name: rule.name,
        nameHi: rule.nameHi,
        crop: rule.crop,
        type: rule.type,
        category: rule.category,
        severity: result.severity,
        riskScore: result.riskScore,
        satisfiedCriteria: result.satisfiedCount,
        totalCriteria: result.totalCriteria,
        weatherDetails: result.details,
        symptoms: rule.symptoms,
        management: rule.management,
        impact: rule.severity_impact[result.severity],
        season: currentSeason
      });
    }
  }
  
  // Sort by risk score descending
  alerts.sort((a, b) => b.riskScore - a.riskScore);
  
  return {
    alerts,
    weather: {
      temp_max: weather.temp_max,
      temp_min: weather.temp_min,
      humidity: weather.humidity,
      rainfall: weather.rainfall,
      source: weather.source
    },
    season: currentSeason,
    location: { lat, lon },
    generated_at: new Date().toISOString()
  };
}

module.exports = { getPestAlerts, PEST_RULES, evaluateRisk, getWeatherForecast, getCurrentSeason };
