'use strict';

/**
 * Machine profile for EF566, extracted from the JOE Android app's
 * bundled machine-catalogue XML (via the jura_connect PyPI package,
 * data/xml/EF566/*.xml). See lib/profiles/README.md for how this
 * was generated. Not live-verified -- see README.md "What's verified".
 */

const PROFILE = {
  "code": "EF566",
  "products": [
    {
      "code": 2,
      "name": "espresso",
      "rawName": "Espresso",
      "active": true,
      "params": [
        {
          "kind": "coffee_strength",
          "argument": 3,
          "offset": 2,
          "default": 8,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "1",
              "value": "01"
            },
            {
              "name": "2",
              "value": "02"
            },
            {
              "name": "3",
              "value": "03"
            },
            {
              "name": "4",
              "value": "04"
            },
            {
              "name": "5",
              "value": "05"
            },
            {
              "name": "6",
              "value": "06"
            },
            {
              "name": "7",
              "value": "07"
            },
            {
              "name": "8",
              "value": "08"
            },
            {
              "name": "9",
              "value": "09"
            },
            {
              "name": "10",
              "value": "0A"
            }
          ]
        },
        {
          "kind": "grinder_ratio",
          "argument": 2,
          "offset": 1,
          "default": 2,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "100_0",
              "value": "00"
            },
            {
              "name": "75_25",
              "value": "01"
            },
            {
              "name": "50_50",
              "value": "02"
            },
            {
              "name": "25_75",
              "value": "03"
            },
            {
              "name": "0_100",
              "value": "04"
            }
          ]
        },
        {
          "kind": "water_amount",
          "argument": 4,
          "offset": 3,
          "default": 45,
          "min": 15,
          "max": 80,
          "step": 5,
          "items": []
        },
        {
          "kind": "temperature",
          "argument": 7,
          "offset": 6,
          "default": 2,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "low",
              "value": "00"
            },
            {
              "name": "normal",
              "value": "01"
            },
            {
              "name": "high",
              "value": "02"
            }
          ]
        }
      ]
    },
    {
      "code": 3,
      "name": "coffee",
      "rawName": "Coffee",
      "active": true,
      "params": [
        {
          "kind": "coffee_strength",
          "argument": 3,
          "offset": 2,
          "default": 5,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "1",
              "value": "01"
            },
            {
              "name": "2",
              "value": "02"
            },
            {
              "name": "3",
              "value": "03"
            },
            {
              "name": "4",
              "value": "04"
            },
            {
              "name": "5",
              "value": "05"
            },
            {
              "name": "6",
              "value": "06"
            },
            {
              "name": "7",
              "value": "07"
            },
            {
              "name": "8",
              "value": "08"
            },
            {
              "name": "9",
              "value": "09"
            },
            {
              "name": "10",
              "value": "0A"
            }
          ]
        },
        {
          "kind": "grinder_ratio",
          "argument": 2,
          "offset": 1,
          "default": 2,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "100_0",
              "value": "00"
            },
            {
              "name": "75_25",
              "value": "01"
            },
            {
              "name": "50_50",
              "value": "02"
            },
            {
              "name": "25_75",
              "value": "03"
            },
            {
              "name": "0_100",
              "value": "04"
            }
          ]
        },
        {
          "kind": "water_amount",
          "argument": 4,
          "offset": 3,
          "default": 100,
          "min": 25,
          "max": 240,
          "step": 5,
          "items": []
        },
        {
          "kind": "temperature",
          "argument": 7,
          "offset": 6,
          "default": 1,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "low",
              "value": "00"
            },
            {
              "name": "normal",
              "value": "01"
            },
            {
              "name": "high",
              "value": "02"
            }
          ]
        }
      ]
    },
    {
      "code": 4,
      "name": "cappuccino",
      "rawName": "Cappuccino",
      "active": true,
      "params": [
        {
          "kind": "coffee_strength",
          "argument": 3,
          "offset": 2,
          "default": 8,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "1",
              "value": "01"
            },
            {
              "name": "2",
              "value": "02"
            },
            {
              "name": "3",
              "value": "03"
            },
            {
              "name": "4",
              "value": "04"
            },
            {
              "name": "5",
              "value": "05"
            },
            {
              "name": "6",
              "value": "06"
            },
            {
              "name": "7",
              "value": "07"
            },
            {
              "name": "8",
              "value": "08"
            },
            {
              "name": "9",
              "value": "09"
            },
            {
              "name": "10",
              "value": "0A"
            }
          ]
        },
        {
          "kind": "grinder_ratio",
          "argument": 2,
          "offset": 1,
          "default": 2,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "100_0",
              "value": "00"
            },
            {
              "name": "75_25",
              "value": "01"
            },
            {
              "name": "50_50",
              "value": "02"
            },
            {
              "name": "25_75",
              "value": "03"
            },
            {
              "name": "0_100",
              "value": "04"
            }
          ]
        },
        {
          "kind": "water_amount",
          "argument": 4,
          "offset": 3,
          "default": 60,
          "min": 25,
          "max": 240,
          "step": 5,
          "items": []
        },
        {
          "kind": "temperature",
          "argument": 7,
          "offset": 6,
          "default": 1,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "low",
              "value": "00"
            },
            {
              "name": "normal",
              "value": "01"
            },
            {
              "name": "high",
              "value": "02"
            }
          ]
        },
        {
          "kind": "milk_foam_amount",
          "argument": 6,
          "offset": 5,
          "default": 14,
          "min": 0,
          "max": 120,
          "step": 1,
          "items": []
        }
      ]
    },
    {
      "code": 5,
      "name": "milkcoffee",
      "rawName": "Milkcoffee",
      "active": true,
      "params": [
        {
          "kind": "coffee_strength",
          "argument": 3,
          "offset": 2,
          "default": 5,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "1",
              "value": "01"
            },
            {
              "name": "2",
              "value": "02"
            },
            {
              "name": "3",
              "value": "03"
            },
            {
              "name": "4",
              "value": "04"
            },
            {
              "name": "5",
              "value": "05"
            },
            {
              "name": "6",
              "value": "06"
            },
            {
              "name": "7",
              "value": "07"
            },
            {
              "name": "8",
              "value": "08"
            },
            {
              "name": "9",
              "value": "09"
            },
            {
              "name": "10",
              "value": "0A"
            }
          ]
        },
        {
          "kind": "grinder_ratio",
          "argument": 2,
          "offset": 1,
          "default": 2,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "100_0",
              "value": "00"
            },
            {
              "name": "75_25",
              "value": "01"
            },
            {
              "name": "50_50",
              "value": "02"
            },
            {
              "name": "25_75",
              "value": "03"
            },
            {
              "name": "0_100",
              "value": "04"
            }
          ]
        },
        {
          "kind": "water_amount",
          "argument": 4,
          "offset": 3,
          "default": 100,
          "min": 25,
          "max": 240,
          "step": 5,
          "items": []
        },
        {
          "kind": "temperature",
          "argument": 7,
          "offset": 6,
          "default": 1,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "low",
              "value": "00"
            },
            {
              "name": "normal",
              "value": "01"
            },
            {
              "name": "high",
              "value": "02"
            }
          ]
        },
        {
          "kind": "milk_foam_amount",
          "argument": 6,
          "offset": 5,
          "default": 0,
          "min": 0,
          "max": 120,
          "step": 1,
          "items": []
        },
        {
          "kind": "milk_amount",
          "argument": 5,
          "offset": 4,
          "default": 10,
          "min": 1,
          "max": 120,
          "step": 1,
          "items": []
        }
      ]
    },
    {
      "code": 6,
      "name": "espresso_macchiato",
      "rawName": "Espresso Macchiato",
      "active": true,
      "params": [
        {
          "kind": "coffee_strength",
          "argument": 3,
          "offset": 2,
          "default": 8,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "1",
              "value": "01"
            },
            {
              "name": "2",
              "value": "02"
            },
            {
              "name": "3",
              "value": "03"
            },
            {
              "name": "4",
              "value": "04"
            },
            {
              "name": "5",
              "value": "05"
            },
            {
              "name": "6",
              "value": "06"
            },
            {
              "name": "7",
              "value": "07"
            },
            {
              "name": "8",
              "value": "08"
            },
            {
              "name": "9",
              "value": "09"
            },
            {
              "name": "10",
              "value": "0A"
            }
          ]
        },
        {
          "kind": "grinder_ratio",
          "argument": 2,
          "offset": 1,
          "default": 2,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "100_0",
              "value": "00"
            },
            {
              "name": "75_25",
              "value": "01"
            },
            {
              "name": "50_50",
              "value": "02"
            },
            {
              "name": "25_75",
              "value": "03"
            },
            {
              "name": "0_100",
              "value": "04"
            }
          ]
        },
        {
          "kind": "water_amount",
          "argument": 4,
          "offset": 3,
          "default": 25,
          "min": 15,
          "max": 80,
          "step": 5,
          "items": []
        },
        {
          "kind": "temperature",
          "argument": 7,
          "offset": 6,
          "default": 1,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "low",
              "value": "00"
            },
            {
              "name": "normal",
              "value": "01"
            },
            {
              "name": "high",
              "value": "02"
            }
          ]
        },
        {
          "kind": "milk_foam_amount",
          "argument": 6,
          "offset": 5,
          "default": 3,
          "min": 0,
          "max": 120,
          "step": 1,
          "items": []
        }
      ]
    },
    {
      "code": 7,
      "name": "latte_macchiato",
      "rawName": "Latte Macchiato",
      "active": true,
      "params": [
        {
          "kind": "coffee_strength",
          "argument": 3,
          "offset": 2,
          "default": 8,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "1",
              "value": "01"
            },
            {
              "name": "2",
              "value": "02"
            },
            {
              "name": "3",
              "value": "03"
            },
            {
              "name": "4",
              "value": "04"
            },
            {
              "name": "5",
              "value": "05"
            },
            {
              "name": "6",
              "value": "06"
            },
            {
              "name": "7",
              "value": "07"
            },
            {
              "name": "8",
              "value": "08"
            },
            {
              "name": "9",
              "value": "09"
            },
            {
              "name": "10",
              "value": "0A"
            }
          ]
        },
        {
          "kind": "grinder_ratio",
          "argument": 2,
          "offset": 1,
          "default": 2,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "100_0",
              "value": "00"
            },
            {
              "name": "75_25",
              "value": "01"
            },
            {
              "name": "50_50",
              "value": "02"
            },
            {
              "name": "25_75",
              "value": "03"
            },
            {
              "name": "0_100",
              "value": "04"
            }
          ]
        },
        {
          "kind": "water_amount",
          "argument": 4,
          "offset": 3,
          "default": 45,
          "min": 25,
          "max": 240,
          "step": 5,
          "items": []
        },
        {
          "kind": "temperature",
          "argument": 7,
          "offset": 6,
          "default": 2,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "low",
              "value": "00"
            },
            {
              "name": "normal",
              "value": "01"
            },
            {
              "name": "high",
              "value": "02"
            }
          ]
        },
        {
          "kind": "milk_foam_amount",
          "argument": 6,
          "offset": 5,
          "default": 22,
          "min": 0,
          "max": 120,
          "step": 1,
          "items": []
        },
        {
          "kind": "milk_amount",
          "argument": 5,
          "offset": 4,
          "default": 4,
          "min": 1,
          "max": 120,
          "step": 1,
          "items": []
        },
        {
          "kind": "milk_break",
          "argument": 11,
          "offset": 10,
          "default": 20,
          "min": 0,
          "max": 60,
          "step": 1,
          "items": []
        }
      ]
    },
    {
      "code": 18,
      "name": "2_espressi",
      "rawName": "2 Espressi",
      "active": true,
      "params": [
        {
          "kind": "grinder_ratio",
          "argument": 2,
          "offset": 1,
          "default": 2,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "100_0",
              "value": "00"
            },
            {
              "name": "75_25",
              "value": "01"
            },
            {
              "name": "50_50",
              "value": "02"
            },
            {
              "name": "25_75",
              "value": "03"
            },
            {
              "name": "0_100",
              "value": "04"
            }
          ]
        },
        {
          "kind": "water_amount",
          "argument": 4,
          "offset": 3,
          "default": 45,
          "min": 15,
          "max": 80,
          "step": 5,
          "items": []
        },
        {
          "kind": "temperature",
          "argument": 7,
          "offset": 6,
          "default": 2,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "low",
              "value": "00"
            },
            {
              "name": "normal",
              "value": "01"
            },
            {
              "name": "high",
              "value": "02"
            }
          ]
        }
      ]
    },
    {
      "code": 19,
      "name": "2_coffee",
      "rawName": "2 Coffee",
      "active": true,
      "params": [
        {
          "kind": "grinder_ratio",
          "argument": 2,
          "offset": 1,
          "default": 2,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "100_0",
              "value": "00"
            },
            {
              "name": "75_25",
              "value": "01"
            },
            {
              "name": "50_50",
              "value": "02"
            },
            {
              "name": "25_75",
              "value": "03"
            },
            {
              "name": "0_100",
              "value": "04"
            }
          ]
        },
        {
          "kind": "water_amount",
          "argument": 4,
          "offset": 3,
          "default": 100,
          "min": 25,
          "max": 240,
          "step": 5,
          "items": []
        },
        {
          "kind": "temperature",
          "argument": 7,
          "offset": 6,
          "default": 1,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "low",
              "value": "00"
            },
            {
              "name": "normal",
              "value": "01"
            },
            {
              "name": "high",
              "value": "02"
            }
          ]
        }
      ]
    },
    {
      "code": 20,
      "name": "2_cappuccino",
      "rawName": " 2 Cappuccino",
      "active": true,
      "params": [
        {
          "kind": "grinder_ratio",
          "argument": 2,
          "offset": 1,
          "default": 2,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "100_0",
              "value": "00"
            },
            {
              "name": "75_25",
              "value": "01"
            },
            {
              "name": "50_50",
              "value": "02"
            },
            {
              "name": "25_75",
              "value": "03"
            },
            {
              "name": "0_100",
              "value": "04"
            }
          ]
        },
        {
          "kind": "water_amount",
          "argument": 4,
          "offset": 3,
          "default": 60,
          "min": 25,
          "max": 240,
          "step": 5,
          "items": []
        },
        {
          "kind": "temperature",
          "argument": 7,
          "offset": 6,
          "default": 1,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "low",
              "value": "00"
            },
            {
              "name": "normal",
              "value": "01"
            },
            {
              "name": "high",
              "value": "02"
            }
          ]
        },
        {
          "kind": "milk_foam_amount",
          "argument": 6,
          "offset": 5,
          "default": 14,
          "min": 0,
          "max": 120,
          "step": 1,
          "items": []
        }
      ]
    },
    {
      "code": 21,
      "name": "2_milkcoffee",
      "rawName": " 2 Milkcoffee",
      "active": true,
      "params": [
        {
          "kind": "grinder_ratio",
          "argument": 2,
          "offset": 1,
          "default": 2,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "100_0",
              "value": "00"
            },
            {
              "name": "75_25",
              "value": "01"
            },
            {
              "name": "50_50",
              "value": "02"
            },
            {
              "name": "25_75",
              "value": "03"
            },
            {
              "name": "0_100",
              "value": "04"
            }
          ]
        },
        {
          "kind": "water_amount",
          "argument": 4,
          "offset": 3,
          "default": 100,
          "min": 15,
          "max": 160,
          "step": 5,
          "items": []
        },
        {
          "kind": "temperature",
          "argument": 7,
          "offset": 6,
          "default": 1,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "low",
              "value": "00"
            },
            {
              "name": "normal",
              "value": "01"
            },
            {
              "name": "high",
              "value": "02"
            }
          ]
        },
        {
          "kind": "milk_foam_amount",
          "argument": 6,
          "offset": 5,
          "default": 0,
          "min": 0,
          "max": 120,
          "step": 1,
          "items": []
        },
        {
          "kind": "milk_amount",
          "argument": 5,
          "offset": 4,
          "default": 10,
          "min": 1,
          "max": 120,
          "step": 1,
          "items": []
        }
      ]
    },
    {
      "code": 22,
      "name": "2_espresso_macchiato",
      "rawName": "2 Espresso Macchiato",
      "active": true,
      "params": [
        {
          "kind": "grinder_ratio",
          "argument": 2,
          "offset": 1,
          "default": 2,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "100_0",
              "value": "00"
            },
            {
              "name": "75_25",
              "value": "01"
            },
            {
              "name": "50_50",
              "value": "02"
            },
            {
              "name": "25_75",
              "value": "03"
            },
            {
              "name": "0_100",
              "value": "04"
            }
          ]
        },
        {
          "kind": "water_amount",
          "argument": 4,
          "offset": 3,
          "default": 25,
          "min": 15,
          "max": 80,
          "step": 5,
          "items": []
        },
        {
          "kind": "temperature",
          "argument": 7,
          "offset": 6,
          "default": 1,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "low",
              "value": "00"
            },
            {
              "name": "normal",
              "value": "01"
            },
            {
              "name": "high",
              "value": "02"
            }
          ]
        },
        {
          "kind": "milk_foam_amount",
          "argument": 6,
          "offset": 5,
          "default": 3,
          "min": 0,
          "max": 120,
          "step": 1,
          "items": []
        }
      ]
    },
    {
      "code": 23,
      "name": "2_latte_macchiato",
      "rawName": "2 Latte Macchiato",
      "active": true,
      "params": [
        {
          "kind": "grinder_ratio",
          "argument": 2,
          "offset": 1,
          "default": 2,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "100_0",
              "value": "00"
            },
            {
              "name": "75_25",
              "value": "01"
            },
            {
              "name": "50_50",
              "value": "02"
            },
            {
              "name": "25_75",
              "value": "03"
            },
            {
              "name": "0_100",
              "value": "04"
            }
          ]
        },
        {
          "kind": "water_amount",
          "argument": 4,
          "offset": 3,
          "default": 45,
          "min": 25,
          "max": 240,
          "step": 5,
          "items": []
        },
        {
          "kind": "temperature",
          "argument": 7,
          "offset": 6,
          "default": 2,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "low",
              "value": "00"
            },
            {
              "name": "normal",
              "value": "01"
            },
            {
              "name": "high",
              "value": "02"
            }
          ]
        },
        {
          "kind": "milk_foam_amount",
          "argument": 6,
          "offset": 5,
          "default": 22,
          "min": 0,
          "max": 120,
          "step": 1,
          "items": []
        },
        {
          "kind": "milk_amount",
          "argument": 5,
          "offset": 4,
          "default": 4,
          "min": 1,
          "max": 120,
          "step": 1,
          "items": []
        },
        {
          "kind": "milk_break",
          "argument": 11,
          "offset": 10,
          "default": 20,
          "min": 0,
          "max": 60,
          "step": 1,
          "items": []
        }
      ]
    },
    {
      "code": 48,
      "name": "espresso_doppio",
      "rawName": "Espresso Doppio",
      "active": true,
      "params": [
        {
          "kind": "coffee_strength",
          "argument": 3,
          "offset": 2,
          "default": 8,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "1",
              "value": "01"
            },
            {
              "name": "2",
              "value": "02"
            },
            {
              "name": "3",
              "value": "03"
            },
            {
              "name": "4",
              "value": "04"
            },
            {
              "name": "5",
              "value": "05"
            },
            {
              "name": "6",
              "value": "06"
            },
            {
              "name": "7",
              "value": "07"
            },
            {
              "name": "8",
              "value": "08"
            },
            {
              "name": "9",
              "value": "09"
            },
            {
              "name": "10",
              "value": "0A"
            }
          ]
        },
        {
          "kind": "grinder_ratio",
          "argument": 2,
          "offset": 1,
          "default": 2,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "100_0",
              "value": "00"
            },
            {
              "name": "75_25",
              "value": "01"
            },
            {
              "name": "50_50",
              "value": "02"
            },
            {
              "name": "25_75",
              "value": "03"
            },
            {
              "name": "0_100",
              "value": "04"
            }
          ]
        },
        {
          "kind": "water_amount",
          "argument": 4,
          "offset": 3,
          "default": 90,
          "min": 15,
          "max": 160,
          "step": 5,
          "items": []
        },
        {
          "kind": "temperature",
          "argument": 7,
          "offset": 6,
          "default": 2,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "low",
              "value": "00"
            },
            {
              "name": "normal",
              "value": "01"
            },
            {
              "name": "high",
              "value": "02"
            }
          ]
        }
      ]
    },
    {
      "code": 8,
      "name": "milk_foam",
      "rawName": "Milk Foam",
      "active": true,
      "params": [
        {
          "kind": "milk_foam_amount",
          "argument": 6,
          "offset": 5,
          "default": 10,
          "min": 0,
          "max": 120,
          "step": 1,
          "items": []
        },
        {
          "kind": "milk_amount",
          "argument": 5,
          "offset": 4,
          "default": 1,
          "min": 1,
          "max": 120,
          "step": 1,
          "items": []
        }
      ]
    },
    {
      "code": 10,
      "name": "milk_portion",
      "rawName": "Milk Portion",
      "active": true,
      "params": [
        {
          "kind": "milk_foam_amount",
          "argument": 6,
          "offset": 5,
          "default": 0,
          "min": 0,
          "max": 120,
          "step": 1,
          "items": []
        },
        {
          "kind": "milk_amount",
          "argument": 5,
          "offset": 4,
          "default": 20,
          "min": 1,
          "max": 120,
          "step": 1,
          "items": []
        }
      ]
    },
    {
      "code": 12,
      "name": "pot",
      "rawName": "Pot",
      "active": true,
      "params": [
        {
          "kind": "coffee_strength",
          "argument": 3,
          "offset": 2,
          "default": 5,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "1",
              "value": "01"
            },
            {
              "name": "2",
              "value": "02"
            },
            {
              "name": "3",
              "value": "03"
            },
            {
              "name": "4",
              "value": "04"
            },
            {
              "name": "5",
              "value": "05"
            },
            {
              "name": "6",
              "value": "06"
            },
            {
              "name": "7",
              "value": "07"
            },
            {
              "name": "8",
              "value": "08"
            },
            {
              "name": "9",
              "value": "09"
            },
            {
              "name": "10",
              "value": "0A"
            }
          ]
        },
        {
          "kind": "grinder_ratio",
          "argument": 2,
          "offset": 1,
          "default": 2,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "100_0",
              "value": "00"
            },
            {
              "name": "75_25",
              "value": "01"
            },
            {
              "name": "50_50",
              "value": "02"
            },
            {
              "name": "25_75",
              "value": "03"
            },
            {
              "name": "0_100",
              "value": "04"
            }
          ]
        },
        {
          "kind": "water_amount",
          "argument": 4,
          "offset": 3,
          "default": 70,
          "min": 25,
          "max": 240,
          "step": 5,
          "items": []
        },
        {
          "kind": "bypass",
          "argument": 10,
          "offset": 9,
          "default": 50,
          "min": 0,
          "max": 240,
          "step": 5,
          "items": []
        },
        {
          "kind": "stroke",
          "argument": 8,
          "offset": 7,
          "default": 3,
          "min": 1,
          "max": 5,
          "step": 1,
          "items": []
        },
        {
          "kind": "temperature",
          "argument": 7,
          "offset": 6,
          "default": 1,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "low",
              "value": "00"
            },
            {
              "name": "normal",
              "value": "01"
            },
            {
              "name": "high",
              "value": "02"
            }
          ]
        }
      ]
    },
    {
      "code": 13,
      "name": "hotwater_portion",
      "rawName": "Hotwater Portion",
      "active": true,
      "params": [
        {
          "kind": "water_amount",
          "argument": 4,
          "offset": 3,
          "default": 220,
          "min": 25,
          "max": 450,
          "step": 5,
          "items": []
        },
        {
          "kind": "temperature",
          "argument": 7,
          "offset": 6,
          "default": 0,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "low",
              "value": "00"
            },
            {
              "name": "normal",
              "value": "01"
            },
            {
              "name": "high",
              "value": "02"
            }
          ]
        }
      ]
    },
    {
      "code": 24,
      "name": "2_milk_foam",
      "rawName": "2 Milk Foam",
      "active": true,
      "params": [
        {
          "kind": "milk_foam_amount",
          "argument": 6,
          "offset": 5,
          "default": 10,
          "min": 0,
          "max": 120,
          "step": 1,
          "items": []
        },
        {
          "kind": "milk_amount",
          "argument": 5,
          "offset": 4,
          "default": 1,
          "min": 1,
          "max": 120,
          "step": 1,
          "items": []
        }
      ]
    },
    {
      "code": 26,
      "name": "2_milk_portion",
      "rawName": "2 Milk Portion",
      "active": true,
      "params": [
        {
          "kind": "milk_foam_amount",
          "argument": 6,
          "offset": 5,
          "default": 0,
          "min": 0,
          "max": 120,
          "step": 1,
          "items": []
        },
        {
          "kind": "milk_amount",
          "argument": 5,
          "offset": 4,
          "default": 20,
          "min": 1,
          "max": 120,
          "step": 1,
          "items": []
        }
      ]
    },
    {
      "code": 45,
      "name": "hotwater_portion_green_tea",
      "rawName": "Hotwater Portion(Green tea)",
      "active": true,
      "params": [
        {
          "kind": "water_amount",
          "argument": 4,
          "offset": 3,
          "default": 220,
          "min": 25,
          "max": 450,
          "step": 5,
          "items": []
        },
        {
          "kind": "temperature",
          "argument": 7,
          "offset": 6,
          "default": 2,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "low",
              "value": "00"
            },
            {
              "name": "normal",
              "value": "01"
            },
            {
              "name": "high",
              "value": "02"
            }
          ]
        }
      ]
    },
    {
      "code": 40,
      "name": "coffee_speed_1",
      "rawName": "Coffee Speed 1",
      "active": true,
      "params": [
        {
          "kind": "coffee_strength",
          "argument": 3,
          "offset": 2,
          "default": 6,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "1",
              "value": "01"
            },
            {
              "name": "2",
              "value": "02"
            },
            {
              "name": "3",
              "value": "03"
            },
            {
              "name": "4",
              "value": "04"
            },
            {
              "name": "5",
              "value": "05"
            },
            {
              "name": "6",
              "value": "06"
            },
            {
              "name": "7",
              "value": "07"
            },
            {
              "name": "8",
              "value": "08"
            },
            {
              "name": "9",
              "value": "09"
            },
            {
              "name": "10",
              "value": "0A"
            }
          ]
        },
        {
          "kind": "grinder_ratio",
          "argument": 2,
          "offset": 1,
          "default": 2,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "100_0",
              "value": "00"
            },
            {
              "name": "75_25",
              "value": "01"
            },
            {
              "name": "50_50",
              "value": "02"
            },
            {
              "name": "25_75",
              "value": "03"
            },
            {
              "name": "0_100",
              "value": "04"
            }
          ]
        },
        {
          "kind": "water_amount",
          "argument": 4,
          "offset": 3,
          "default": 60,
          "min": 25,
          "max": 240,
          "step": 5,
          "items": []
        },
        {
          "kind": "bypass",
          "argument": 10,
          "offset": 9,
          "default": 40,
          "min": 0,
          "max": 240,
          "step": 5,
          "items": []
        },
        {
          "kind": "temperature",
          "argument": 7,
          "offset": 6,
          "default": 1,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "low",
              "value": "00"
            },
            {
              "name": "normal",
              "value": "01"
            },
            {
              "name": "high",
              "value": "02"
            }
          ]
        }
      ]
    },
    {
      "code": 41,
      "name": "coffee_speed_2",
      "rawName": "Coffee Speed 2",
      "active": true,
      "params": [
        {
          "kind": "coffee_strength",
          "argument": 3,
          "offset": 2,
          "default": 7,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "1",
              "value": "01"
            },
            {
              "name": "2",
              "value": "02"
            },
            {
              "name": "3",
              "value": "03"
            },
            {
              "name": "4",
              "value": "04"
            },
            {
              "name": "5",
              "value": "05"
            },
            {
              "name": "6",
              "value": "06"
            },
            {
              "name": "7",
              "value": "07"
            },
            {
              "name": "8",
              "value": "08"
            },
            {
              "name": "9",
              "value": "09"
            },
            {
              "name": "10",
              "value": "0A"
            }
          ]
        },
        {
          "kind": "grinder_ratio",
          "argument": 2,
          "offset": 1,
          "default": 2,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "100_0",
              "value": "00"
            },
            {
              "name": "75_25",
              "value": "01"
            },
            {
              "name": "50_50",
              "value": "02"
            },
            {
              "name": "25_75",
              "value": "03"
            },
            {
              "name": "0_100",
              "value": "04"
            }
          ]
        },
        {
          "kind": "water_amount",
          "argument": 4,
          "offset": 3,
          "default": 120,
          "min": 25,
          "max": 240,
          "step": 5,
          "items": []
        },
        {
          "kind": "bypass",
          "argument": 10,
          "offset": 9,
          "default": 100,
          "min": 0,
          "max": 240,
          "step": 5,
          "items": []
        },
        {
          "kind": "temperature",
          "argument": 7,
          "offset": 6,
          "default": 1,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "low",
              "value": "00"
            },
            {
              "name": "normal",
              "value": "01"
            },
            {
              "name": "high",
              "value": "02"
            }
          ]
        }
      ]
    },
    {
      "code": 46,
      "name": "1_flat_white",
      "rawName": "1 Flat White",
      "active": true,
      "params": [
        {
          "kind": "coffee_strength",
          "argument": 3,
          "offset": 2,
          "default": 5,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "1",
              "value": "01"
            },
            {
              "name": "2",
              "value": "02"
            },
            {
              "name": "3",
              "value": "03"
            },
            {
              "name": "4",
              "value": "04"
            },
            {
              "name": "5",
              "value": "05"
            },
            {
              "name": "6",
              "value": "06"
            },
            {
              "name": "7",
              "value": "07"
            },
            {
              "name": "8",
              "value": "08"
            },
            {
              "name": "9",
              "value": "09"
            },
            {
              "name": "10",
              "value": "0A"
            }
          ]
        },
        {
          "kind": "grinder_ratio",
          "argument": 2,
          "offset": 1,
          "default": 2,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "100_0",
              "value": "00"
            },
            {
              "name": "75_25",
              "value": "01"
            },
            {
              "name": "50_50",
              "value": "02"
            },
            {
              "name": "25_75",
              "value": "03"
            },
            {
              "name": "0_100",
              "value": "04"
            }
          ]
        },
        {
          "kind": "water_amount",
          "argument": 4,
          "offset": 3,
          "default": 60,
          "min": 25,
          "max": 240,
          "step": 5,
          "items": []
        },
        {
          "kind": "temperature",
          "argument": 7,
          "offset": 6,
          "default": 1,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "low",
              "value": "00"
            },
            {
              "name": "normal",
              "value": "01"
            },
            {
              "name": "high",
              "value": "02"
            }
          ]
        },
        {
          "kind": "milk_foam_amount",
          "argument": 6,
          "offset": 5,
          "default": 2,
          "min": 0,
          "max": 120,
          "step": 1,
          "items": []
        },
        {
          "kind": "milk_amount",
          "argument": 5,
          "offset": 4,
          "default": 14,
          "min": 1,
          "max": 120,
          "step": 1,
          "items": []
        }
      ]
    },
    {
      "code": 43,
      "name": "1_cortado",
      "rawName": "1 Cortado",
      "active": true,
      "params": [
        {
          "kind": "coffee_strength",
          "argument": 3,
          "offset": 2,
          "default": 8,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "1",
              "value": "01"
            },
            {
              "name": "2",
              "value": "02"
            },
            {
              "name": "3",
              "value": "03"
            },
            {
              "name": "4",
              "value": "04"
            },
            {
              "name": "5",
              "value": "05"
            },
            {
              "name": "6",
              "value": "06"
            },
            {
              "name": "7",
              "value": "07"
            },
            {
              "name": "8",
              "value": "08"
            },
            {
              "name": "9",
              "value": "09"
            },
            {
              "name": "10",
              "value": "0A"
            }
          ]
        },
        {
          "kind": "grinder_ratio",
          "argument": 2,
          "offset": 1,
          "default": 2,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "100_0",
              "value": "00"
            },
            {
              "name": "75_25",
              "value": "01"
            },
            {
              "name": "50_50",
              "value": "02"
            },
            {
              "name": "25_75",
              "value": "03"
            },
            {
              "name": "0_100",
              "value": "04"
            }
          ]
        },
        {
          "kind": "water_amount",
          "argument": 4,
          "offset": 3,
          "default": 45,
          "min": 15,
          "max": 80,
          "step": 5,
          "items": []
        },
        {
          "kind": "temperature",
          "argument": 7,
          "offset": 6,
          "default": 2,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "low",
              "value": "00"
            },
            {
              "name": "normal",
              "value": "01"
            },
            {
              "name": "high",
              "value": "02"
            }
          ]
        },
        {
          "kind": "milk_foam_amount",
          "argument": 6,
          "offset": 5,
          "default": 5,
          "min": 0,
          "max": 120,
          "step": 1,
          "items": []
        },
        {
          "kind": "milk_amount",
          "argument": 5,
          "offset": 4,
          "default": 1,
          "min": 1,
          "max": 120,
          "step": 1,
          "items": []
        }
      ]
    },
    {
      "code": 56,
      "name": "2_coffee_speed_1",
      "rawName": "2 Coffee Speed 1",
      "active": true,
      "params": [
        {
          "kind": "grinder_ratio",
          "argument": 2,
          "offset": 1,
          "default": 2,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "100_0",
              "value": "00"
            },
            {
              "name": "75_25",
              "value": "01"
            },
            {
              "name": "50_50",
              "value": "02"
            },
            {
              "name": "25_75",
              "value": "03"
            },
            {
              "name": "0_100",
              "value": "04"
            }
          ]
        },
        {
          "kind": "water_amount",
          "argument": 4,
          "offset": 3,
          "default": 60,
          "min": 25,
          "max": 240,
          "step": 5,
          "items": []
        },
        {
          "kind": "bypass",
          "argument": 10,
          "offset": 9,
          "default": 40,
          "min": 0,
          "max": 240,
          "step": 5,
          "items": []
        },
        {
          "kind": "temperature",
          "argument": 7,
          "offset": 6,
          "default": 1,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "low",
              "value": "00"
            },
            {
              "name": "normal",
              "value": "01"
            },
            {
              "name": "high",
              "value": "02"
            }
          ]
        }
      ]
    },
    {
      "code": 57,
      "name": "2_coffee_speed_2",
      "rawName": "2 Coffee Speed 2",
      "active": true,
      "params": [
        {
          "kind": "grinder_ratio",
          "argument": 2,
          "offset": 1,
          "default": 2,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "100_0",
              "value": "00"
            },
            {
              "name": "75_25",
              "value": "01"
            },
            {
              "name": "50_50",
              "value": "02"
            },
            {
              "name": "25_75",
              "value": "03"
            },
            {
              "name": "0_100",
              "value": "04"
            }
          ]
        },
        {
          "kind": "water_amount",
          "argument": 4,
          "offset": 3,
          "default": 120,
          "min": 25,
          "max": 240,
          "step": 5,
          "items": []
        },
        {
          "kind": "bypass",
          "argument": 10,
          "offset": 9,
          "default": 100,
          "min": 0,
          "max": 240,
          "step": 5,
          "items": []
        },
        {
          "kind": "temperature",
          "argument": 7,
          "offset": 6,
          "default": 1,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "low",
              "value": "00"
            },
            {
              "name": "normal",
              "value": "01"
            },
            {
              "name": "high",
              "value": "02"
            }
          ]
        }
      ]
    },
    {
      "code": 59,
      "name": "2_cortado",
      "rawName": "2 Cortado",
      "active": true,
      "params": [
        {
          "kind": "coffee_strength",
          "argument": 3,
          "offset": 2,
          "default": 8,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "1",
              "value": "01"
            },
            {
              "name": "2",
              "value": "02"
            },
            {
              "name": "3",
              "value": "03"
            },
            {
              "name": "4",
              "value": "04"
            },
            {
              "name": "5",
              "value": "05"
            },
            {
              "name": "6",
              "value": "06"
            },
            {
              "name": "7",
              "value": "07"
            },
            {
              "name": "8",
              "value": "08"
            },
            {
              "name": "9",
              "value": "09"
            },
            {
              "name": "10",
              "value": "0A"
            }
          ]
        },
        {
          "kind": "grinder_ratio",
          "argument": 2,
          "offset": 1,
          "default": 2,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "100_0",
              "value": "00"
            },
            {
              "name": "75_25",
              "value": "01"
            },
            {
              "name": "50_50",
              "value": "02"
            },
            {
              "name": "25_75",
              "value": "03"
            },
            {
              "name": "0_100",
              "value": "04"
            }
          ]
        },
        {
          "kind": "water_amount",
          "argument": 4,
          "offset": 3,
          "default": 45,
          "min": 15,
          "max": 80,
          "step": 5,
          "items": []
        },
        {
          "kind": "temperature",
          "argument": 7,
          "offset": 6,
          "default": 2,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "low",
              "value": "00"
            },
            {
              "name": "normal",
              "value": "01"
            },
            {
              "name": "high",
              "value": "02"
            }
          ]
        },
        {
          "kind": "milk_foam_amount",
          "argument": 6,
          "offset": 5,
          "default": 5,
          "min": 0,
          "max": 120,
          "step": 1,
          "items": []
        },
        {
          "kind": "milk_amount",
          "argument": 5,
          "offset": 4,
          "default": 1,
          "min": 1,
          "max": 120,
          "step": 1,
          "items": []
        }
      ]
    },
    {
      "code": 62,
      "name": "2_flat_white",
      "rawName": "2 Flat White",
      "active": true,
      "params": [
        {
          "kind": "grinder_ratio",
          "argument": 2,
          "offset": 1,
          "default": 2,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "100_0",
              "value": "00"
            },
            {
              "name": "75_25",
              "value": "01"
            },
            {
              "name": "50_50",
              "value": "02"
            },
            {
              "name": "25_75",
              "value": "03"
            },
            {
              "name": "0_100",
              "value": "04"
            }
          ]
        },
        {
          "kind": "water_amount",
          "argument": 4,
          "offset": 3,
          "default": 60,
          "min": 25,
          "max": 240,
          "step": 5,
          "items": []
        },
        {
          "kind": "temperature",
          "argument": 7,
          "offset": 6,
          "default": 1,
          "min": null,
          "max": null,
          "step": null,
          "items": [
            {
              "name": "low",
              "value": "00"
            },
            {
              "name": "normal",
              "value": "01"
            },
            {
              "name": "high",
              "value": "02"
            }
          ]
        },
        {
          "kind": "milk_foam_amount",
          "argument": 6,
          "offset": 5,
          "default": 2,
          "min": 0,
          "max": 120,
          "step": 1,
          "items": []
        },
        {
          "kind": "milk_amount",
          "argument": 5,
          "offset": 4,
          "default": 14,
          "min": 1,
          "max": 120,
          "step": 1,
          "items": []
        }
      ]
    },
    {
      "code": 15,
      "name": "powderproduct",
      "rawName": "Powderproduct",
      "active": false,
      "params": []
    }
  ],
  "alerts": [
    {
      "bit": 0,
      "name": "insert_tray",
      "severity": "error",
      "rawName": "insert tray"
    },
    {
      "bit": 1,
      "name": "fill_water",
      "severity": "error",
      "rawName": "fill water"
    },
    {
      "bit": 2,
      "name": "empty_grounds",
      "severity": "error",
      "rawName": "empty grounds"
    },
    {
      "bit": 3,
      "name": "empty_tray",
      "severity": "error",
      "rawName": "empty tray"
    },
    {
      "bit": 4,
      "name": "insert_coffee_bin",
      "severity": "error",
      "rawName": "insert coffee bin"
    },
    {
      "bit": 5,
      "name": "outlet_missing",
      "severity": "error",
      "rawName": "outlet missing"
    },
    {
      "bit": 6,
      "name": "rear_cover_missing",
      "severity": "error",
      "rawName": "rear cover missing"
    },
    {
      "bit": 7,
      "name": "milk_alert",
      "severity": "info",
      "rawName": "milk alert"
    },
    {
      "bit": 8,
      "name": "fill_system",
      "severity": "error",
      "rawName": "fill system"
    },
    {
      "bit": 9,
      "name": "system_filling",
      "severity": "info",
      "rawName": "system filling"
    },
    {
      "bit": 10,
      "name": "no_beans",
      "severity": "info",
      "rawName": "no beans"
    },
    {
      "bit": 11,
      "name": "welcome",
      "severity": "info",
      "rawName": "welcome"
    },
    {
      "bit": 12,
      "name": "heating_up",
      "severity": "error",
      "rawName": "heating up"
    },
    {
      "bit": 13,
      "name": "coffee_ready",
      "severity": "info",
      "rawName": "coffee ready"
    },
    {
      "bit": 14,
      "name": "no_milk_milk_sensor",
      "severity": "info",
      "rawName": "no milk (milk sensor)"
    },
    {
      "bit": 15,
      "name": "error_milk_milk_sensor",
      "severity": "info",
      "rawName": "error milk (milk sensor)"
    },
    {
      "bit": 16,
      "name": "no_signal_milk_sensor",
      "severity": "info",
      "rawName": "no signal (milk sensor)"
    },
    {
      "bit": 17,
      "name": "please_wait",
      "severity": "error",
      "rawName": "please wait"
    },
    {
      "bit": 18,
      "name": "coffee_rinsing",
      "severity": "info",
      "rawName": "coffee rinsing"
    },
    {
      "bit": 19,
      "name": "ventilation_closed",
      "severity": "info",
      "rawName": "ventilation closed"
    },
    {
      "bit": 20,
      "name": "close_powder_cover",
      "severity": "info",
      "rawName": "close powder cover"
    },
    {
      "bit": 21,
      "name": "fill_powder",
      "severity": "info",
      "rawName": "fill powder"
    },
    {
      "bit": 22,
      "name": "system_emptying",
      "severity": "info",
      "rawName": "system emptying"
    },
    {
      "bit": 23,
      "name": "not_enough_powder",
      "severity": "info",
      "rawName": "not enough powder"
    },
    {
      "bit": 24,
      "name": "remove_water_tank",
      "severity": "info",
      "rawName": "remove water tank"
    },
    {
      "bit": 25,
      "name": "press_rinse",
      "severity": "info",
      "rawName": "press rinse"
    },
    {
      "bit": 26,
      "name": "goodbye",
      "severity": "info",
      "rawName": "goodbye"
    },
    {
      "bit": 27,
      "name": "periphery_alert",
      "severity": "info",
      "rawName": "periphery alert"
    },
    {
      "bit": 28,
      "name": "powder_product",
      "severity": "info",
      "rawName": "powder product"
    },
    {
      "bit": 29,
      "name": "program_mode_status",
      "severity": "error",
      "rawName": "program-mode status"
    },
    {
      "bit": 30,
      "name": "error_status",
      "severity": "error",
      "rawName": "error status"
    },
    {
      "bit": 31,
      "name": "enjoy_product",
      "severity": "info",
      "rawName": "enjoy product"
    },
    {
      "bit": 32,
      "name": "filter_alert",
      "severity": "process",
      "rawName": "filter alert"
    },
    {
      "bit": 33,
      "name": "descale_alert",
      "severity": "process",
      "rawName": "decalc alert"
    },
    {
      "bit": 34,
      "name": "cleaning_alert",
      "severity": "process",
      "rawName": "cleaning alert"
    },
    {
      "bit": 35,
      "name": "cappu_rinse_alert",
      "severity": "process",
      "rawName": "cappu rinse alert"
    },
    {
      "bit": 36,
      "name": "energy_safe",
      "severity": "info",
      "rawName": "energy safe"
    },
    {
      "bit": 37,
      "name": "active_rf_filter",
      "severity": "info",
      "rawName": "active RF filter"
    },
    {
      "bit": 38,
      "name": "remote_screen",
      "severity": "info",
      "rawName": "RemoteScreen"
    },
    {
      "bit": 39,
      "name": "locked_keys",
      "severity": "info",
      "rawName": "LockedKeys"
    },
    {
      "bit": 40,
      "name": "close_tab",
      "severity": "error",
      "rawName": "close tab"
    },
    {
      "bit": 41,
      "name": "cappu_clean_alert",
      "severity": "process",
      "rawName": "cappu clean alert"
    },
    {
      "bit": 42,
      "name": "info_cappu_clean_alert",
      "severity": "info",
      "rawName": "Info - cappu clean alert"
    },
    {
      "bit": 43,
      "name": "info_coffee_clean_alert",
      "severity": "info",
      "rawName": "Info - coffee clean alert"
    },
    {
      "bit": 44,
      "name": "info_descale_alert",
      "severity": "info",
      "rawName": "Info - decalc alert"
    },
    {
      "bit": 45,
      "name": "info_filter_used_up_alert",
      "severity": "info",
      "rawName": "Info - filter used up alert"
    },
    {
      "bit": 46,
      "name": "steam_ready",
      "severity": "info",
      "rawName": "steam ready"
    },
    {
      "bit": 47,
      "name": "switch_off_delay_active",
      "severity": "error",
      "rawName": "SwitchOff Delay active"
    },
    {
      "bit": 48,
      "name": "close_front_cover",
      "severity": "error",
      "rawName": "close front cover"
    },
    {
      "bit": 49,
      "name": "left_bean_alert",
      "severity": "info",
      "rawName": "left bean alert"
    },
    {
      "bit": 50,
      "name": "right_bean_alert",
      "severity": "info",
      "rawName": "right bean alert"
    },
    {
      "bit": 53,
      "name": "empty_grounds_rtc",
      "severity": "info",
      "rawName": "empty grounds RTC"
    }
  ]
};

module.exports = PROFILE;
