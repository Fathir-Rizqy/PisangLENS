const regionExamples = [
    { province: 'Jawa Barat', cities: ['Kota Bandung', 'Kabupaten Bandung', 'Kota Bogor'] },
    { province: 'Jawa Tengah', cities: ['Kota Semarang', 'Kabupaten Semarang', 'Kota Surakarta'] },
    { province: 'Jawa Timur', cities: ['Kota Surabaya', 'Kabupaten Sidoarjo', 'Kota Malang'] },
];

export function initializeRegionExamples(scope) {
    const province = scope.querySelector('[name="province"]');
    const city = scope.querySelector('[name="city"]');
    if (!province || !city) return;
    const prefix = scope.id || 'professional-region';
    const provinces = document.createElement('datalist');
    const cities = document.createElement('datalist');
    provinces.id = prefix + '-province-examples';
    cities.id = prefix + '-city-examples';
    for (const region of regionExamples) {
        const option = document.createElement('option');
        option.value = region.province;
        provinces.append(option);
    }
    province.setAttribute('list', provinces.id);
    city.setAttribute('list', cities.id);
    scope.append(provinces, cities);
    function updateCities() {
        cities.replaceChildren();
        const example = regionExamples.find(region => region.province === province.value.trim());
        for (const name of example?.cities ?? []) {
            const option = document.createElement('option');
            option.value = name;
            cities.append(option);
        }
    }
    province.addEventListener('input', updateCities);
    province.addEventListener('change', updateCities);
    scope.addEventListener('reset', () => queueMicrotask(updateCities));
    updateCities();
    return updateCities;
}
