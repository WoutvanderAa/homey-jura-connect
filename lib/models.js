'use strict';

/**
 * Model registry -- the ONE place to touch when adding support for a
 * new Jura WiFi Connect machine.
 *
 * All 72 models from the jura_connect PyPI package's JOE_MACHINES.TXT
 * catalogue are bundled here. Only the E8 (EF533V2, article 15336 /
 * hwId EF538M) has been live-verified against real hardware so far --
 * see README.md "What's verified" for the current list. Every other
 * profile's product/recipe data is extracted the same way (see
 * lib/profiles/README.md) but untested against a physical machine.
 *
 * To add a model that's somehow missing (e.g. released after this was
 * generated):
 *   1. Find its EF code(s) -- see lib/profiles/README.md for how to
 *      pull one out of the `jura_connect` PyPI package (same tool
 *      used to generate every profile already bundled here).
 *   2. Drop the generated file in lib/profiles/<EF_CODE>.js.
 *   3. Add one entry per hardware revision below: friendly name,
 *      profile file, and the article numbers Jura shipped for it
 *      (from jura_connect's JOE_MACHINES.TXT).
 * Nothing else needs to change -- driver.js, device.js and juraClient.js
 * are all already model-agnostic and read everything through this file.
 */

const PROFILE_FILES = {
  EF1089: require('./profiles/EF1089'),
  EF1090: require('./profiles/EF1090'),
  EF1184: require('./profiles/EF1184'),
  EF529: require('./profiles/EF529'),
  EF526: require('./profiles/EF526'),
  EF1119: require('./profiles/EF1119'),
  EF1031: require('./profiles/EF1031'),
  EF532: require('./profiles/EF532'),
  EF532coffeeonly: require('./profiles/EF532coffeeonly'),
  EF532V2: require('./profiles/EF532V2'),
  EF1030: require('./profiles/EF1030'),
  EF1121: require('./profiles/EF1121'),
  EF533: require('./profiles/EF533'),
  EF533V2: require('./profiles/EF533V2'),
  EF537: require('./profiles/EF537'),
  EF538: require('./profiles/EF538'),
  EF1092: require('./profiles/EF1092'),
  EF1120: require('./profiles/EF1120'),
  EF1013: require('./profiles/EF1013'),
  EF1148: require('./profiles/EF1148'),
  EF555: require('./profiles/EF555'),
  EF1012: require('./profiles/EF1012'),
  EF1070: require('./profiles/EF1070'),
  EF1065: require('./profiles/EF1065'),
  EF657: require('./profiles/EF657'),
  EF566: require('./profiles/EF566'),
  EF566UL: require('./profiles/EF566UL'),
  EF1097: require('./profiles/EF1097'),
  EF722UL_W: require('./profiles/EF722UL_W'),
  EF722W: require('./profiles/EF722W'),
  EF567: require('./profiles/EF567'),
  EF722: require('./profiles/EF722'),
  EF722UL: require('./profiles/EF722UL'),
  EF567_c: require('./profiles/EF567_c'),
  EF722_c: require('./profiles/EF722_c'),
  EF659: require('./profiles/EF659'),
  EF659_c: require('./profiles/EF659_c'),
  EF565: require('./profiles/EF565'),
  EF565UL: require('./profiles/EF565UL'),
  EF658S: require('./profiles/EF658S'),
  EF565_c: require('./profiles/EF565_c'),
  EF658S_c: require('./profiles/EF658S_c'),
  EF658: require('./profiles/EF658'),
  EF658_c: require('./profiles/EF658_c'),
  EF539: require('./profiles/EF539'),
  EF1139: require('./profiles/EF1139'),
  EF557: require('./profiles/EF557'),
  EF1069: require('./profiles/EF1069'),
  EF1060: require('./profiles/EF1060'),
  EF1123: require('./profiles/EF1123'),
  EF536: require('./profiles/EF536'),
  EF1091: require('./profiles/EF1091'),
  EF1151: require('./profiles/EF1151'),
  EF1115: require('./profiles/EF1115'),
  EF1096: require('./profiles/EF1096'),
  EF534: require('./profiles/EF534'),
  EF535: require('./profiles/EF535'),
  EF535V2: require('./profiles/EF535V2'),
  EF561: require('./profiles/EF561'),
  EF1100: require('./profiles/EF1100'),
  EF1127: require('./profiles/EF1127'),
  EF1105: require('./profiles/EF1105'),
  EF1128: require('./profiles/EF1128'),
  EF562: require('./profiles/EF562'),
  EF560: require('./profiles/EF560'),
  EF1106: require('./profiles/EF1106'),
  EF1208: require('./profiles/EF1208'),
  EF545: require('./profiles/EF545'),
  EF540: require('./profiles/EF540'),
  EF542: require('./profiles/EF542'),
  EF541: require('./profiles/EF541'),
  EF541UL: require('./profiles/EF541UL'),
};

/**
 * One entry per known hardware revision. `articleNumbers` drives
 * auto-detection at pairing time (from the discovery reply); `label`
 * is what the pairing dropdown shows when auto-detection can't find a
 * match and the user has to pick manually. The EF code in the label
 * doubles as a way to self-identify: the machine's own discovery reply
 * (or its data plate) usually shows the EF/hwId code directly.
 */
const MODELS = [
  {
    label: "C3 (EA) (EF1089)",
    profileCode: "EF1089",
    articleNumbers: [15599, 15600, 15711, 15780, 15834, 15856],
  },
  {
    label: "C8 (EA) (EF1090)",
    profileCode: "EF1090",
    articleNumbers: [15603, 15604, 15689, 15690],
  },
  {
    label: "C9 (EA) (EF1184)",
    profileCode: "EF1184",
    articleNumbers: [15738, 15739, 15751, 15753, 15754, 15757, 15810, 15813, 15853],
  },
  {
    label: "D4 (EF529)",
    profileCode: "EF529",
    articleNumbers: [14018, 15221, 15294],
  },
  {
    label: "D6 (EF526)",
    profileCode: "EF526",
    articleNumbers: [15181, 15193, 15199, 15200, 15214, 15215, 15216, 15246, 15324],
  },
  {
    label: "E10 (EA) (EF1119)",
    profileCode: "EF1119",
    articleNumbers: [15743],
  },
  {
    label: "E4 (SA) (EF1031)",
    profileCode: "EF1031",
    articleNumbers: [15433, 15434, 15435, 15436, 15466, 15512, 15532, 15536, 15539, 15560, 15623],
  },
  {
    label: "E6 (EF532)",
    profileCode: "EF532",
    articleNumbers: [15058, 15067, 15070, 15079, 15081, 15082, 15098, 15099, 15174, 15232, 15243, 15260, 15265, 15450],
  },
  {
    label: "E6 (EF532coffeeonly)",
    profileCode: "EF532coffeeonly",
    articleNumbers: [15209],
  },
  {
    label: "E6 (EB) (EF532V2)",
    profileCode: "EF532V2",
    articleNumbers: [14016, 15326, 15327, 15328, 15329, 15342, 15350, 15362, 15376, 15377, 15378, 15379, 15431, 15447, 15458, 15459],
  },
  {
    label: "E6 (EC) (EF1030)",
    profileCode: "EF1030",
    articleNumbers: [15437, 15438, 15439, 15440, 15441, 15465, 15467, 15511, 15534, 15535, 15537, 15538, 15551, 15559, 15621, 15622, 15645, 15676, 15802],
  },
  {
    label: "E6 (SD) (EF1121)",
    profileCode: "EF1121",
    articleNumbers: [15640, 15641, 15642, 15643, 15805, 15828, 15829, 15831, 15832, 15843, 15850, 15851, 15852, 15854],
  },
  {
    label: "E8 (EF533)",
    profileCode: "EF533",
    articleNumbers: [13791, 15057, 15072, 15083, 15084, 15094, 15096, 15097, 15108, 15109, 15157, 15161, 15233, 15234],
  },
  {
    label: "E8 (EF533V2)",
    profileCode: "EF533V2",
    articleNumbers: [14006, 15235, 15247, 15250, 15251, 15266, 15267, 15268, 15270, 15271, 15272, 15279, 15288, 15295, 15306, 15307, 15341],
  },
  {
    label: "E8 (EA) (EF537)",
    profileCode: "EF537",
    articleNumbers: [15293, 15298],
  },
  {
    label: "E8 (EB) (EF538)",
    profileCode: "EF538",
    articleNumbers: [15336, 15337, 15353, 15354, 15355, 15356, 15363, 15364, 15365, 15366, 15371, 15372, 15400, 15422, 15427, 15428, 15442, 15446, 15475, 15490, 15498, 15635, 15637, 15638],
    verified: true,
  },
  {
    label: "E8 (EC) (EF1092)",
    profileCode: "EF1092",
    articleNumbers: [15581, 15582, 15583, 15584, 15585, 15586, 15587, 15588, 15589, 15590, 15646, 15647, 15648, 15661, 15662, 15683, 15688, 15693, 15710, 15740, 15752],
  },
  {
    label: "E8 (SD) (EF1120)",
    profileCode: "EF1120",
    articleNumbers: [15712, 15713, 15721, 15722, 15745, 15746, 15747, 15748, 15749, 15750, 15759, 15768, 15777, 15808, 15818, 15833, 15839, 15840, 15841, 15842, 15844, 15845],
  },
  {
    label: "ENA 4 (EA) (EF1013)",
    profileCode: "EF1013",
    articleNumbers: [15344, 15345, 15346, 15347, 15351, 15374, 15375, 15407, 15429, 15430, 15432, 15468, 15472, 15499, 15500, 15501, 15502, 15508, 15514, 15516, 15517, 15518, 15519, 15521, 15524, 15525, 15528, 15592, 15607, 15608],
  },
  {
    label: "ENA 5 (EA) (EF1148)",
    profileCode: "EF1148",
    articleNumbers: [15696, 15697],
  },
  {
    label: "ENA 8 (EF555)",
    profileCode: "EF555",
    articleNumbers: [14008, 14010, 15222, 15239, 15240, 15241, 15252, 15253, 15254, 15255, 15278, 15280, 15281, 15282, 15283, 15284, 15291, 15292, 15313, 15314, 15315, 15316, 15318, 15319, 15320, 15321, 15338, 15352, 15370, 15451, 15473],
  },
  {
    label: "ENA 8 (EA) (EF1012)",
    profileCode: "EF1012",
    articleNumbers: [15330, 15331, 15332, 15333, 15339, 15340],
  },
  {
    label: "ENA 8 (EC) (EF1070)",
    profileCode: "EF1070",
    articleNumbers: [15491, 15492, 15493, 15494, 15495, 15496, 15509, 15510, 15513, 15515, 15520, 15522, 15523, 15526, 15529, 15530, 15531, 15580, 15591, 15597, 15598],
  },
  {
    label: "GIGA 10 (EA) (EF1065)",
    profileCode: "EF1065",
    articleNumbers: [15478, 15479, 15527, 15558, 15633],
  },
  {
    label: "GIGA 5 (EF657)",
    profileCode: "EF657",
    articleNumbers: [13582, 13583, 13629, 13646, 13666, 13686, 13687, 13688, 13689, 13717],
  },
  {
    label: "GIGA 6 (EF566)",
    profileCode: "EF566",
    articleNumbers: [15310, 15323, 15357, 15393, 15394, 15395],
  },
  {
    label: "GIGA 6 (EF566UL)",
    profileCode: "EF566UL",
    articleNumbers: [15274, 15396, 15408],
  },
  {
    label: "GIGA W10 (SA) (EF1097)",
    profileCode: "EF1097",
    articleNumbers: [15548, 15549, 15631, 15632],
  },
  {
    label: "GIGA W3 Professional (EF722UL_W)",
    profileCode: "EF722UL_W",
    articleNumbers: [15089],
  },
  {
    label: "GIGA W3 Professional (EF722W)",
    profileCode: "EF722W",
    articleNumbers: [15071],
  },
  {
    label: "GIGA X3 (EF567)",
    profileCode: "EF567",
    articleNumbers: [14011, 14014, 14021, 14026, 15229, 15312, 15397, 15405, 15567, 15569, 15666],
  },
  {
    label: "GIGA X3 Professional (EF722)",
    profileCode: "EF722",
    articleNumbers: [15002, 15050],
  },
  {
    label: "GIGA X3 Professional (EF722UL)",
    profileCode: "EF722UL",
    articleNumbers: [15164, 15176],
  },
  {
    label: "GIGA X3c (EF567_c)",
    profileCode: "EF567_c",
    articleNumbers: [14012, 14015, 14022, 14025, 15230, 15311, 15325, 15398, 15399, 15406, 15463, 15571, 15572, 15665, 15686, 15695],
  },
  {
    label: "GIGA X3c Professional (EF722_c)",
    profileCode: "EF722_c",
    articleNumbers: [13783, 15003, 15047],
  },
  {
    label: "GIGA X7 Professional (EF659)",
    profileCode: "EF659",
    articleNumbers: [13585, 13675, 13677, 13718],
  },
  {
    label: "GIGA X7c Professional (EF659_c)",
    profileCode: "EF659_c",
    articleNumbers: [13712, 13749],
  },
  {
    label: "GIGA X8 (EF565)",
    profileCode: "EF565",
    articleNumbers: [14001, 14004, 14019, 14023, 15226, 15248, 15256, 15258, 15385, 15387, 15403, 15565, 15566, 15687],
  },
  {
    label: "GIGA X8 (NAA) (EF565UL)",
    profileCode: "EF565UL",
    articleNumbers: [15392],
  },
  {
    label: "GIGA X8 Professional (EF658S)",
    profileCode: "EF658S",
    articleNumbers: [13742, 13784, 15036],
  },
  {
    label: "GIGA X8c (EF565_c)",
    profileCode: "EF565_c",
    articleNumbers: [14003, 14005, 14020, 14024, 15227, 15249, 15257, 15259, 15261, 15289, 15386, 15388, 15389, 15390, 15404, 15568, 15570, 15667, 15685, 15692, 15806],
  },
  {
    label: "GIGA X8c Professional (EF658S_c)",
    profileCode: "EF658S_c",
    articleNumbers: [13724, 13744, 13745, 15037, 15087, 15112],
  },
  {
    label: "GIGA X9 Professional (EF658)",
    profileCode: "EF658",
    articleNumbers: [13600, 13678],
  },
  {
    label: "GIGA X9c Professional (EF658_c)",
    profileCode: "EF658_c",
    articleNumbers: [13598, 13679],
  },
  {
    label: "J10 (EA) (EF539)",
    profileCode: "EF539",
    articleNumbers: [15562, 15593, 15664, 15726],
  },
  {
    label: "J10 twin (NAA) (EF1139)",
    profileCode: "EF1139",
    articleNumbers: [15706, 15707, 15723, 15724, 15793, 15794],
  },
  {
    label: "J6 (EF557)",
    profileCode: "EF557",
    articleNumbers: [13796, 15111, 15131, 15136, 15149, 15150, 15165, 15166, 15179, 15180, 15273, 15469],
  },
  {
    label: "J8 (EA) (EF1069)",
    profileCode: "EF1069",
    articleNumbers: [15457, 15460, 15461, 15462, 15470, 15471, 15555, 15556, 15557, 15630, 15639],
  },
  {
    label: "J8 twin (NAA) (EF1060)",
    profileCode: "EF1060",
    articleNumbers: [15561, 15594, 15595, 15596, 15657, 15658, 15659, 15825, 15826],
  },
  {
    label: "S10 (EA) (EF1123)",
    profileCode: "EF1123",
    articleNumbers: [15773, 15774, 15775, 15776, 15795, 15796, 15835, 15849],
  },
  {
    label: "S8 (EF536)",
    profileCode: "EF536",
    articleNumbers: [13798, 15172, 15187, 15201, 15202, 15203, 15204, 15210, 15211, 15212, 15228, 15238, 15287, 15358, 15380, 15381, 15382, 15383, 15384, 15409, 15443, 15455, 15474],
  },
  {
    label: "S8 (EB) (EF1091)",
    profileCode: "EF1091",
    articleNumbers: [15480, 15484],
  },
  {
    label: "S8 (NAB) (EF1151)",
    profileCode: "EF1151",
    articleNumbers: [15482, 15483, 15486, 15487, 15651, 15652, 15653, 15694, 15755],
  },
  {
    label: "W4 (SA) (EF1115)",
    profileCode: "EF1115",
    articleNumbers: [15541, 15542, 15734, 15807],
  },
  {
    label: "W8 (EA) (EF1096)",
    profileCode: "EF1096",
    articleNumbers: [15550, 15552, 15650, 15663, 15699, 15709, 15727, 15765, 15766],
  },
  {
    label: "WE6 (EF534)",
    profileCode: "EF534",
    articleNumbers: [13793, 15114, 15122, 15140, 15197, 15343, 15417, 15418, 15426, 15452],
  },
  {
    label: "WE8 (EF535)",
    profileCode: "EF535",
    articleNumbers: [13792, 15091, 15141, 15144, 15145, 15146, 15173, 15188, 15194, 15198],
  },
  {
    label: "WE8 (EF535V2)",
    profileCode: "EF535V2",
    articleNumbers: [14009, 15285, 15286, 15301, 15317, 15322, 15419, 15420, 15421, 15448, 15453, 15497, 15533],
  },
  {
    label: "X10 (EF561)",
    profileCode: "EF561",
    articleNumbers: [15276, 15277],
  },
  {
    label: "X10 (SA) (EF1100)",
    profileCode: "EF1100",
    articleNumbers: [15545, 15546, 15668, 15669, 15684, 15705, 15708, 15728, 15733, 15763, 15764, 15781, 15782, 15783, 15784, 15797, 15798, 15799],
  },
  {
    label: "X10c (EA) (EF1127)",
    profileCode: "EF1127",
    articleNumbers: [15624, 15625],
  },
  {
    label: "X4 (SA) (EF1105)",
    profileCode: "EF1105",
    articleNumbers: [15543, 15544, 15725, 15761, 15762, 15785],
  },
  {
    label: "X4c (EA) (EF1128)",
    profileCode: "EF1128",
    articleNumbers: [15626, 15627],
  },
  {
    label: "X6 (EF562)",
    profileCode: "EF562",
    articleNumbers: [14000, 15153, 15154, 15415, 15416, 15454],
  },
  {
    label: "X8 (EF560)",
    profileCode: "EF560",
    articleNumbers: [13799, 15100, 15152, 15169, 15177, 15191, 15223, 15242, 15413, 15414, 15425, 15444, 15449, 15456, 15477, 15547],
  },
  {
    label: "Z10 (EB) (EF1106)",
    profileCode: "EF1106",
    articleNumbers: [15609, 15610, 15613, 15614, 15615, 15616, 15617, 15618, 15619, 15620, 15702, 15703, 15767, 15771, 15772, 15792, 15811, 15812, 15821, 15846, 15847],
  },
  {
    label: "Z10 (EC) (EF1208)",
    profileCode: "EF1208",
    articleNumbers: [15836, 15838],
  },
  {
    label: "Z10 (NAA) (EF545)",
    profileCode: "EF545",
    articleNumbers: [15348, 15349, 15360, 15361, 15367, 15368, 15369, 15410, 15411, 15412, 15423, 15424, 15445, 15464, 15476, 15488, 15489, 15503, 15504, 15507, 15553, 15554, 15629, 15634, 15636, 15655, 15656, 15677, 15678, 15756, 15820, 15822, 15823],
  },
  {
    label: "Z6 (EF540)",
    profileCode: "EF540",
    articleNumbers: [13795, 15011, 15041, 15074, 15092, 15093, 15095, 15104, 15105, 15128, 15129, 15134, 15162, 15163, 15175, 15182, 15183, 15184, 15206, 15208, 15231],
  },
  {
    label: "Z6 (EF542)",
    profileCode: "EF542",
    articleNumbers: [14007, 15225, 15237, 15244, 15245, 15263, 15290, 15335],
  },
  {
    label: "Z8 (EF541)",
    profileCode: "EF541",
    articleNumbers: [14002, 14013, 15062, 15063, 15147, 15205, 15207, 15213, 15299, 15300, 15302, 15304, 15305, 15308, 15309],
  },
  {
    label: "Z8 (EF541UL)",
    profileCode: "EF541UL",
    articleNumbers: [15192],
  },
];

const DEFAULT_PROFILE_CODE = 'EF538';

// Only models with `verified: true` have actually been run against
// physical hardware (see README.md "What's verified"). Everything
// else is mechanically-extracted catalogue data -- flagged as
// experimental in every user-facing label rather than presented with
// false confidence.
function displayLabel(model) {
  return model.verified ? model.label : `${model.label} — experimental, untested`;
}

/** @returns {{label:string, profileCode:string}[]} for pairing-screen dropdowns */
function listModels() {
  return MODELS.map((m) => ({ label: displayLabel(m), profileCode: m.profileCode }));
}

/**
 * @param {number} articleNumber
 * @returns {{label:string, profileCode:string}|null} the matching model, or null if unknown
 */
function modelForArticle(articleNumber) {
  const model = MODELS.find((m) => m.articleNumbers.includes(articleNumber));
  return model ? { label: displayLabel(model), profileCode: model.profileCode } : null;
}

/**
 * @param {string} code e.g. 'EF533V2'
 * @returns {{code: string, products: object[], alerts: object[]}}
 */
function getProfile(code) {
  const p = PROFILE_FILES[code];
  if (!p) {
    const known = Object.keys(PROFILE_FILES).join(', ');
    throw new Error(`Unknown machine profile "${code}". Bundled profiles: ${known}`);
  }
  return p;
}

module.exports = {
  MODELS,
  DEFAULT_PROFILE_CODE,
  listModels,
  modelForArticle,
  getProfile,
  knownProfileCodes: Object.keys(PROFILE_FILES),
};
