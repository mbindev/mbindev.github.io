import Image from "next/image";

export default function Home() {
  return (
    <div className="min-h-screen bg-white text-slate-900 font-[family-name:var(--font-geist-sans)]">
      {/* Navigation */}
      <nav className="w-full bg-white border-b border-slate-100 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-20 items-center">
            <div className="flex-shrink-0 flex items-center">
              <Image
                src="/logo.png"
                alt="mbin logo"
                width={120}
                height={120}
                className="h-16 w-auto"
                priority
              />
              <span className="ml-3 text-2xl font-bold tracking-tight text-[#cc0000]">Dev Team</span>
            </div>
            <div className="hidden sm:ml-6 sm:flex sm:space-x-8">
              <a href="#" className="border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700 inline-flex items-center px-1 pt-1 border-b-2 text-sm font-medium">
                Home
              </a>
              <a href="#focus" className="border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700 inline-flex items-center px-1 pt-1 border-b-2 text-sm font-medium">
                Our Focus
              </a>
            </div>
          </div>
        </div>
      </nav>

      <main>
        {/* Hero Section */}
        <div className="relative bg-white overflow-hidden">
          <div className="max-w-7xl mx-auto">
            <div className="relative z-10 pb-8 bg-white sm:pb-16 md:pb-20 lg:max-w-2xl lg:w-full lg:pb-28 xl:pb-32 pt-20">
              <main className="mt-10 mx-auto max-w-7xl px-4 sm:mt-12 sm:px-6 md:mt-16 lg:mt-20 lg:px-8 xl:mt-28">
                <div className="sm:text-center lg:text-left">
                  <h1 className="text-4xl tracking-tight font-extrabold text-slate-900 sm:text-5xl md:text-6xl">
                    <span className="block xl:inline">Engineering the future of</span>{' '}
                    <span className="block text-[#cc0000] xl:inline">global commerce</span>
                  </h1>
                  <p className="mt-3 text-base text-slate-500 sm:mt-5 sm:text-lg sm:max-w-xl sm:mx-auto md:mt-5 md:text-xl lg:mx-0">
                    We are the mbin development team. We build modern, scalable applications that power commerce worldwide. Our passion is delivering high-quality software through innovation and collaboration.
                  </p>
                  <div className="mt-5 sm:mt-8 sm:flex sm:justify-center lg:justify-start">
                    <div className="rounded-md shadow">
                      <a href="#focus" className="w-full flex items-center justify-center px-8 py-3 border border-transparent text-base font-medium rounded-md text-white bg-[#cc0000] hover:bg-[#aa0000] md:py-4 md:text-lg md:px-10 transition-colors">
                        Learn more
                      </a>
                    </div>
                  </div>
                </div>
              </main>
            </div>
          </div>
          <div className="lg:absolute lg:inset-y-0 lg:right-0 lg:w-1/2 bg-slate-50 flex items-center justify-center">
            {/* Abstract geometric representation of code/development */}
             <div className="relative w-full h-64 sm:h-72 md:h-96 lg:h-full flex items-center justify-center p-12">
               <div className="grid grid-cols-2 gap-4 w-full max-w-md opacity-20">
                 <div className="h-32 bg-[#cc0000] rounded-tl-3xl rounded-br-3xl"></div>
                 <div className="h-32 bg-slate-400 rounded-tr-3xl rounded-bl-3xl"></div>
                 <div className="h-32 bg-slate-400 rounded-tr-3xl rounded-bl-3xl"></div>
                 <div className="h-32 bg-[#cc0000] rounded-tl-3xl rounded-br-3xl"></div>
               </div>
            </div>
          </div>
        </div>

        {/* Focus Areas Section */}
        <div id="focus" className="py-16 bg-slate-50 overflow-hidden lg:py-24">
          <div className="relative max-w-xl mx-auto px-4 sm:px-6 lg:px-8 lg:max-w-7xl">
            <div className="relative">
              <h2 className="text-center text-3xl leading-8 font-extrabold tracking-tight text-slate-900 sm:text-4xl">
                What we do best
              </h2>
              <p className="mt-4 max-w-3xl mx-auto text-center text-xl text-slate-500">
                Our team focuses on three core pillars to deliver exceptional value and reliable systems.
              </p>
            </div>

            <div className="relative mt-12 lg:mt-24 lg:grid lg:grid-cols-3 lg:gap-8 lg:items-center">
              <div className="relative mb-10 lg:mb-0">
                <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100 hover:shadow-md transition-shadow">
                  <div className="w-12 h-12 bg-red-100 rounded-xl flex items-center justify-center mb-6">
                    <svg className="w-6 h-6 text-[#cc0000]" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"></path></svg>
                  </div>
                  <h3 className="text-2xl font-bold text-slate-900">Modern Applications</h3>
                  <p className="mt-3 text-lg text-slate-500">
                    We leverage the latest technologies and frameworks to build responsive, performant, and accessible applications for our users.
                  </p>
                </div>
              </div>

              <div className="relative mb-10 lg:mb-0">
                <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100 hover:shadow-md transition-shadow">
                  <div className="w-12 h-12 bg-red-100 rounded-xl flex items-center justify-center mb-6">
                    <svg className="w-6 h-6 text-[#cc0000]" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9"></path></svg>
                  </div>
                  <h3 className="text-2xl font-bold text-slate-900">Global Commerce</h3>
                  <p className="mt-3 text-lg text-slate-500">
                    Our systems are designed to handle scale. We build robust architectures that support international transactions seamlessly.
                  </p>
                </div>
              </div>

              <div className="relative mb-10 lg:mb-0">
                <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100 hover:shadow-md transition-shadow">
                  <div className="w-12 h-12 bg-red-100 rounded-xl flex items-center justify-center mb-6">
                    <svg className="w-6 h-6 text-[#cc0000]" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>
                  </div>
                  <h3 className="text-2xl font-bold text-slate-900">Innovation</h3>
                  <p className="mt-3 text-lg text-slate-500">
                    We constantly explore new patterns, tools, and methodologies to improve our developer experience and product quality.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="bg-white border-t border-slate-200">
        <div className="max-w-7xl mx-auto py-12 px-4 sm:px-6 md:flex md:items-center md:justify-between lg:px-8">
          <div className="flex justify-center space-x-6 md:order-2">
            <a href="#" className="text-slate-400 hover:text-slate-500">
              <span className="sr-only">GitHub</span>
              <svg className="h-6 w-6" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path fillRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" clipRule="evenodd" />
              </svg>
            </a>
          </div>
          <div className="mt-8 md:mt-0 md:order-1 flex items-center justify-center md:justify-start">
             <Image
                src="/logo.png"
                alt="mbin logo"
                width={32}
                height={32}
                className="h-6 w-auto grayscale opacity-50"
              />
            <p className="text-center text-base text-slate-400 ml-3">
              &copy; {new Date().getFullYear()} mbin. All rights reserved.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
