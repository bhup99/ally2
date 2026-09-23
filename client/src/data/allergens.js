// Built-in allergen list with synonym/derivative terms used for matching.
// Keep labels short and plain; matching is case-insensitive on word boundaries.
export const ALLERGENS = [
  { id: 'peanut', label: 'Peanut', terms: ['peanut', 'peanuts', 'groundnut', 'groundnuts', 'arachis', 'monkey nut'] },
  { id: 'tree-nuts', label: 'Tree nuts', terms: ['almond', 'almonds', 'brazil nut', 'cashew', 'cashews', 'hazelnut', 'hazelnuts', 'macadamia', 'pecan', 'pecans', 'pistachio', 'pistachios', 'walnut', 'walnuts', 'pine nut', 'chestnut', 'filbert', 'tree nut'] },
  { id: 'milk', label: 'Milk / Dairy', terms: ['milk', 'dairy', 'whey', 'casein', 'caseinate', 'lactose', 'lactalbumin', 'ghee', 'butter', 'cream', 'cheese', 'yogurt', 'yoghurt', 'curd', 'paneer'] },
  { id: 'egg', label: 'Egg', terms: ['egg', 'eggs', 'albumin', 'albumen', 'lysozyme', 'mayonnaise', 'meringue', 'ovalbumin'] },
  { id: 'wheat-gluten', label: 'Wheat / Gluten', terms: ['wheat', 'gluten', 'barley', 'rye', 'malt', 'spelt', 'semolina', 'durum', 'farro', 'triticale', 'kamut', 'couscous', 'seitan', 'flour'] },
  { id: 'soy', label: 'Soy', terms: ['soy', 'soya', 'tofu', 'tempeh', 'miso', 'edamame', 'soybean', 'soybeans'] },
  { id: 'fish', label: 'Fish', terms: ['fish', 'anchovy', 'anchovies', 'tuna', 'salmon', 'cod', 'haddock', 'sardine', 'sardines', 'tilapia', 'trout'] },
  { id: 'shellfish', label: 'Shellfish', terms: ['shrimp', 'shrimps', 'prawn', 'prawns', 'crab', 'lobster', 'clam', 'clams', 'mussel', 'mussels', 'oyster', 'oysters', 'scallop', 'scallops', 'shellfish', 'crawfish', 'crayfish'] },
  { id: 'sesame', label: 'Sesame', terms: ['sesame', 'tahini', 'sesamol', 'sesamum'] },
  { id: 'mustard', label: 'Mustard', terms: ['mustard'] },
  { id: 'celery', label: 'Celery', terms: ['celery', 'celeriac'] },
  { id: 'lupin', label: 'Lupin', terms: ['lupin', 'lupine', 'lupins'] },
  { id: 'sulfites', label: 'Sulfites', terms: ['sulfite', 'sulfites', 'sulphite', 'sulphites', 'sulfur dioxide', 'sulphur dioxide', 'sodium bisulfite', 'potassium metabisulfite'] },
  { id: 'corn', label: 'Corn / Maize', terms: ['corn', 'maize', 'cornstarch', 'corn starch', 'corn syrup'] },
];
