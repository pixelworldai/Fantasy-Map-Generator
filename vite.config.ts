export default {
    root: './src',
    base: process.env.RPBUDDY ? '/fmg/' : process.env.NETLIFY ? '/' : '/Fantasy-Map-Generator/',
    build: {
        outDir: '../dist',
        assetsDir: './',
    },
    publicDir: '../public',
    server: {
        port: 5174,
    },
}