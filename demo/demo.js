// Demo-specific Service Worker entry point.
// Lives next to demo.html so its default scope covers /demo/ without needing
// a Service-Worker-Allowed header — which GitHub Pages cannot send.
// All real logic is in the library SW; importScripts pulls it in here so
// self.location.search (the registration URL query string) remains readable.
importScripts('../public/turso-sw.js');
