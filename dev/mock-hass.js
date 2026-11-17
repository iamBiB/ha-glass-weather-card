// Mock `hass` for the dev harness. Builds states and a daily forecast from the
// same demo data as reference/weather-card-reference.html.

export const CONDITIONS = [
    'sunny', 'partlycloudy', 'clear-night', 'cloudy', 'fog', 'windy', 'windy-variant',
    'rainy', 'pouring', 'lightning', 'lightning-rainy', 'snowy', 'snowy-rainy', 'hail',
    'exceptional', 'unknown', 'unavailable',
];

const LABEL = {
    sunny: 'Sunny', partlycloudy: 'Partly cloudy', 'clear-night': 'Clear, night', cloudy: 'Cloudy',
    fog: 'Fog', windy: 'Windy', 'windy-variant': 'Windy, cloudy', rainy: 'Rainy', pouring: 'Pouring',
    lightning: 'Lightning', 'lightning-rainy': 'Lightning, rainy', snowy: 'Snowy', 'snowy-rainy': 'Snowy, rainy',
    hail: 'Hail', exceptional: 'Exceptional', unknown: 'Unknown', unavailable: 'Unavailable',
};

// next days after today
const DAYS = [
    { w: 'sunny', t: 28, lo: 18, feels: 30, hum: 34, wind: 8 },
    { w: 'cloudy', t: 21, lo: 14, feels: 21, hum: 58, wind: 12 },
    { w: 'rainy', t: 17, lo: 12, feels: 16, hum: 82, wind: 19 },
    { w: 'lightning-rainy', t: 15, lo: 10, feels: 13, hum: 90, wind: 32 },
    { w: 'snowy', t: -3, lo: -7, feels: -8, hum: 76, wind: 11 },
    { w: 'partlycloudy', t: 12, lo: 5, feels: 11, hum: 61, wind: 14 },
    { w: 'fog', t: 9, lo: 6, feels: 8, hum: 95, wind: 4 },
];

function forecast() {
    const base = new Date();
    base.setHours(12, 0, 0, 0);
    const out = [{ datetime: base.toISOString(), condition: 'rainy', temperature: 18, templow: 11, humidity: 80, wind_speed: 18 }];
    DAYS.forEach((d, i) => {
        const dt = new Date(base);
        dt.setDate(base.getDate() + i + 1);
        out.push({
            datetime: dt.toISOString(), condition: d.w, temperature: d.t, templow: d.lo,
            apparent_temperature: d.feels, humidity: d.hum, wind_speed: d.wind, precipitation_probability: 20,
        });
    });
    return out;
}

// One connection per page, shared by all hass objects, so the harness can count
// live subscriptions (should return to 0 after detaching every card).
export const connection = {
    active: 0,
    failNext: false,
    subscribeMessage(callback, msg) {
        if (msg.type !== 'weather/subscribe_forecast') return Promise.reject(new Error('unknown command'));
        if (connection.failNext) return Promise.reject({ code: 'not_supported', message: 'Forecast not supported' });
        connection.active++;
        let live = true;
        setTimeout(() => live && callback({ type: msg.forecast_type, forecast: forecast() }), 80);
        return Promise.resolve(() => {
            if (live) connection.active--;
            live = false;
        });
    },
};

export function createMockHass({
    condition = 'rainy',
    sunDown = false,
    missingAttrs = false,
    noForecast = false,
    language = 'en',
    timeFormat = 'language',
} = {}) {
    connection.failNext = noForecast;
    const unavailable = condition === 'unavailable';
    const attributes = unavailable
        ? { friendly_name: 'Northaven', supported_features: 3 }
        : missingAttrs
            ? { friendly_name: 'Northaven', temperature: 17, temperature_unit: '°C', supported_features: 3 }
            : {
                friendly_name: 'Northaven', temperature: 17, apparent_temperature: 16, humidity: 82,
                wind_speed: 19, temperature_unit: '°C', wind_speed_unit: 'km/h', supported_features: 3,
            };
    const now = new Date().toISOString();
    const weather = { entity_id: 'weather.home', state: condition, attributes, last_updated: now, last_changed: now };
    return {
        states: {
            'weather.home': weather,
            'weather.other': { ...weather, entity_id: 'weather.other', attributes: { ...attributes, friendly_name: 'Second city' } },
            'sun.sun': { entity_id: 'sun.sun', state: sunDown ? 'below_horizon' : 'above_horizon', attributes: {} },
        },
        language,
        locale: { language, time_format: timeFormat, time_zone: 'local', number_format: 'language' },
        config: { time_zone: 'Europe/Bucharest', unit_system: { temperature: '°C' } },
        connection,
        localize: () => '',
        formatEntityState: (stateObj, state) => LABEL[state ?? stateObj.state] ?? (state ?? stateObj.state),
        formatEntityAttributeName: (stateObj, attr) => ({ apparent_temperature: 'Gefühlt', humidity: 'Feuchte', wind_speed: 'Wind' })[attr] ?? attr,
    };
}
