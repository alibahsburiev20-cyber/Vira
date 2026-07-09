const config = {
  appId: 'app.vira.messenger',
  appName: 'Vira',
  webDir: 'frontend',
  server: {
    androidScheme: 'https',
  },
  android: {
    backgroundColor: '#FDFBF7',
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 0, // мы используем свою HTML-splash анимацию вместо нативной
      backgroundColor: '#FDFBF7',
      showSpinner: false,
    },
  },
};

module.exports = config;
